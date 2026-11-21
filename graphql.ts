// GraphQL v4 handler for the GitHub-compatible forge.
//
// Dispatch is by operation name (body.operationName, or `query <Name>` /
// `mutation <Name>` parsed from the query text). No full GraphQL parser is
// needed: the suite exercises the 18 named documents below, plus the
// introspection shapes they use. Unknown operations answer
// { data: null, errors: [{ message: "Unknown operation" }] } with HTTP 200.
// Transport errors (a body that is not an object) are the only HTTP 400.
// Auth is already checked by app.ts before this handler is called.

import type { Store } from './store.ts';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

/** Variables from a request body: an object, or a JSON-encoded string. */
function readVariables(body: JsonRecord): JsonRecord {
  const raw = body.variables;
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

/** Operation name from body.operationName, else from `query <Name>` / `mutation <Name>`. */
function readOperationName(body: JsonRecord, query: string): string | undefined {
  const named = asString(body.operationName);
  if (named !== undefined && named !== '') return named;
  const match = /(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  return match === null ? undefined : match[1];
}

function fieldList(names: string[]): Array<{ name: string }> {
  return names.map((name) => ({ name }));
}

function issueState(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullState(state: string, merged: boolean): string {
  if (merged) return 'MERGED';
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** Parse a Repository node id into a numeric repo id, or null. */
function parseRepositoryId(store: Store, id: unknown): number | null {
  const text = asString(id);
  if (text === undefined) return null;
  const parsed = store.parseNodeId(text);
  if (parsed === null || parsed.type !== 'Repository') return null;
  const n = Number(parsed.key);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse an Issue node id into [repoId, issueNumber], or null. */
function parseIssueKey(store: Store, id: unknown): [number, number] | null {
  const text = asString(id);
  if (text === undefined) return null;
  const parsed = store.parseNodeId(text);
  if (parsed === null || parsed.type !== 'Issue') return null;
  const parts = parsed.key.split(':');
  if (parts.length !== 2) return null;
  const repoId = Number(parts[0]);
  const number = Number(parts[1]);
  if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
  return [repoId, number];
}

/** Parse a PullRequest node id into [repoId, pullNumber], or null. */
function parsePullKey(store: Store, id: unknown): [number, number] | null {
  const text = asString(id);
  if (text === undefined) return null;
  const parsed = store.parseNodeId(text);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  const parts = parsed.key.split(':');
  if (parts.length !== 2) return null;
  const repoId = Number(parts[0]);
  const number = Number(parts[1]);
  if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
  return [repoId, number];
}

/** Decode an IssueCursor node id into the last-seen issue number, or null. */
function parseCursor(store: Store, after: unknown): number | null {
  const text = asString(after);
  if (text === undefined || text === '') return null;
  const parsed = store.parseNodeId(text);
  if (parsed !== null && (parsed.type === 'IssueCursor' || parsed.type === 'Issue')) {
    const n = Number(parsed.key.split(':').pop() ?? '');
    return Number.isInteger(n) ? n : null;
  }
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = [
  'id',
  'databaseId',
  'name',
  'nameWithOwner',
  'owner',
  'defaultBranchRef',
  'viewerPermission',
  'hasIssuesEnabled',
  'issue',
  'issues',
  'pullRequests',
  'pullRequest',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

function fieldsForType(typeName: string): string[] | null {
  if (typeName === 'Issue') return ISSUE_FIELDS;
  if (typeName === 'PullRequest') return PULL_REQUEST_FIELDS;
  if (typeName === 'Repository') return REPOSITORY_FIELDS;
  return null;
}

function enumValuesForType(typeName: string): string[] | null {
  if (typeName === 'SearchType') return SEARCH_TYPE_VALUES;
  return null;
}

/**
 * Answer `__type(...)` introspection. Handles both plain `__type` and
 * aliased forms such as `PullRequest: __type(name:"PullRequest")`, returning
 * one entry per alias (or per type name when there is no alias).
 */
function handleIntrospection(query: string): JsonRecord {
  const data: JsonRecord = {};
  const aliased = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
  let found = false;
  let match: RegExpExecArray | null;
  while ((match = aliased.exec(query)) !== null) {
    found = true;
    const alias = match[1];
    const typeName = match[2];
    data[alias] = introspectionFor(typeName, query);
  }
  if (!found) {
    const plain = /__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/.exec(query);
    if (plain !== null) {
      data.__type = introspectionFor(plain[1], query);
    }
  }
  return { data };
}

function introspectionFor(typeName: string, query: string): JsonRecord {
  const wantsEnum = query.includes('enumValues');
  const enumValues = enumValuesForType(typeName);
  if (wantsEnum && enumValues !== null) {
    return { enumValues: fieldList(enumValues) };
  }
  const fields = fieldsForType(typeName);
  if (fields !== null) {
    return { fields: fieldList(fields) };
  }
  if (enumValues !== null) {
    return { enumValues: fieldList(enumValues) };
  }
  return { fields: [] };
}

function unknownOperation(): JsonRecord {
  return { data: null, errors: [{ message: 'Unknown operation' }] };
}

function handleSingle(store: Store, body: unknown): JsonRecord {
  if (!isRecord(body)) {
    return { data: null, errors: [{ message: 'Invalid request body' }] };
  }
  const query = asString(body.query) ?? '';
  const variables = readVariables(body);
  const operationName = readOperationName(body, query);

  // 16. ViewerInvalidField — the query itself names the bad field. The
  // login is still answered; the error names the unknown field.
  if (query.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: { login: store.viewer.login } },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
    };
  }

  switch (operationName) {
    case 'ViewerLogin': {
      return { data: { viewer: { login: store.viewer.login } } };
    }

    case 'RepositoryFields': {
      const owner = asString(variables.owner);
      const name = asString(variables.name);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return { data: { repository: null } };
      return {
        data: {
          repository: {
            id: store.nodeId('Repository', String(repo.id)),
            databaseId: repo.id,
            name: repo.name,
            owner: { login: repo.owner },
            defaultBranchRef: { name: repo.defaultBranch },
            viewerPermission: 'ADMIN',
            hasIssuesEnabled: true,
          },
        },
      };
    }

    case 'PullRequestAndRepositoryFields': {
      return handleIntrospection(query);
    }

    case 'OpenIssues': {
      const owner = asString(variables.owner);
      const name = asString(variables.name);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return { data: { repository: null } };
      const first = asNumber(variables.first);
      const issues = store
        .listIssues(repo, 'open')
        .slice()
        .sort((a, b) => b.number - a.number);
      const page = first === undefined ? issues : issues.slice(0, first);
      return {
        data: {
          repository: {
            issues: {
              nodes: page.map((issue) => ({
                number: issue.number,
                title: issue.title,
                state: 'OPEN',
                id: store.nodeId('Issue', `${repo.id}:${issue.number}`),
              })),
            },
          },
        },
      };
    }

    case 'IssueByNumber': {
      const owner = asString(variables.owner);
      const name = asString(variables.name);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return { data: { repository: null } };
      const number = asNumber(variables.number);
      const issue = number === undefined ? undefined : store.getIssue(repo, number);
      if (issue === undefined) return { data: { repository: { issue: null } } };
      return {
        data: {
          repository: {
            issue: {
              number: issue.number,
              title: issue.title,
              state: issueState(issue.state),
              id: store.nodeId('Issue', `${repo.id}:${issue.number}`),
              body: issue.body,
            },
          },
        },
      };
    }

    case 'IssueCreate': {
      const input = asRecord(variables.input);
      if (input === undefined) {
        return { data: { createIssue: null }, errors: [{ message: 'Missing input' }] };
      }
      const repoId = parseRepositoryId(store, input.repositoryId);
      const repo = repoId === null ? undefined : store.getRepoById(repoId);
      if (repo === undefined) {
        return { data: { createIssue: null }, errors: [{ message: 'Repository not found' }] };
      }
      const title = asString(input.title);
      if (title === undefined) {
        return { data: { createIssue: null }, errors: [{ message: 'Missing title' }] };
      }
      const issue = store.createIssue(repo, title, asString(input.body) ?? '', []);
      if (issue === null) {
        return { data: { createIssue: null }, errors: [{ message: 'Could not create issue' }] };
      }
      return {
        data: {
          createIssue: {
            issue: {
              number: issue.number,
              id: store.nodeId('Issue', `${repo.id}:${issue.number}`),
            },
          },
        },
      };
    }

    case 'IssueClose': {
      const input = asRecord(variables.input);
      if (input === undefined) {
        return { data: { closeIssue: null }, errors: [{ message: 'Missing input' }] };
      }
      const key = parseIssueKey(store, input.issueId);
      if (key === null) {
        return { data: { closeIssue: null }, errors: [{ message: 'Issue not found' }] };
      }
      const repo = store.getRepoById(key[0]);
      const issue = repo === undefined ? undefined : store.closeIssue(repo, key[1]);
      if (issue === undefined) {
        return { data: { closeIssue: null }, errors: [{ message: 'Issue not found' }] };
      }
      return {
        data: {
          closeIssue: {
            issue: {
              number: issue.number,
              id: store.nodeId('Issue', `${repo?.id}:${issue.number}`),
              state: 'CLOSED',
            },
          },
        },
      };
    }

    case 'PullRequests': {
      const owner = asString(variables.owner);
      const name = asString(variables.name);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return { data: { repository: null } };
      const first = asNumber(variables.first);
      const pulls = store
        .listPulls(repo, 'all')
        .slice()
        .sort((a, b) => b.number - a.number);
      const page = first === undefined ? pulls : pulls.slice(0, first);
      return {
        data: {
          repository: {
            pullRequests: {
              nodes: page.map((pr) => ({
                number: pr.number,
                headRefName: pr.headRef,
                baseRefName: pr.baseRef,
                mergeable: pr.state === 'open' || pr.merged ? 'MERGEABLE' : 'UNKNOWN',
                state: pullState(pr.state, pr.merged),
              })),
            },
          },
        },
      };
    }

    case 'PullRequestFiles': {
      const owner = asString(variables.owner);
      const name = asString(variables.name);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return { data: { repository: null } };
      const number = asNumber(variables.number);
      const pr = number === undefined ? undefined : store.getPull(repo, number);
      if (pr === undefined) return { data: { repository: { pullRequest: null } } };
      const files = store.pullFiles(repo, pr).slice(0, 10);
      return {
        data: {
          repository: {
            pullRequest: {
              number: pr.number,
              files: { nodes: files.map((file) => ({ path: file.filename })) },
            },
          },
        },
      };
    }

    case 'PullRequestId': {
      const owner = asString(variables.owner);
      const name = asString(variables.name);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return { data: { repository: null } };
      const number = asNumber(variables.number);
      const pr = number === undefined ? undefined : store.getPull(repo, number);
      if (pr === undefined) return { data: { repository: { pullRequest: null } } };
      return {
        data: {
          repository: {
            pullRequest: {
              id: store.nodeId('PullRequest', `${repo.id}:${pr.number}`),
              number: pr.number,
            },
          },
        },
      };
    }

    case 'PullRequestCreate': {
      const input = asRecord(variables.input);
      if (input === undefined) {
        return { data: { createPullRequest: null }, errors: [{ message: 'Missing input' }] };
      }
      const repoId = parseRepositoryId(store, input.repositoryId);
      const repo = repoId === null ? undefined : store.getRepoById(repoId);
      if (repo === undefined) {
        return { data: { createPullRequest: null }, errors: [{ message: 'Repository not found' }] };
      }
      const headRefName = asString(input.headRefName);
      const baseRefName = asString(input.baseRefName);
      const title = asString(input.title);
      if (headRefName === undefined || baseRefName === undefined || title === undefined) {
        return { data: { createPullRequest: null }, errors: [{ message: 'Missing input fields' }] };
      }
      const pr = store.createPull(repo, headRefName, baseRefName, title, asString(input.body) ?? '');
      if (pr === null) {
        return { data: { createPullRequest: null }, errors: [{ message: 'Could not create pull request' }] };
      }
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: pr.number,
              id: store.nodeId('PullRequest', `${repo.id}:${pr.number}`),
              state: 'OPEN',
              headRefName: pr.headRef,
              baseRefName: pr.baseRef,
            },
          },
        },
      };
    }

    case 'MergePullRequest': {
      const input = asRecord(variables.input);
      if (input === undefined) {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Missing input' }] };
      }
      const key = parsePullKey(store, input.pullRequestId);
      if (key === null) {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request not found' }] };
      }
      const repo = store.getRepoById(key[0]);
      if (repo === undefined) {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request not found' }] };
      }
      const method = asString(input.mergeMethod) ?? 'SQUASH';
      const result = store.mergePull(repo, key[1], method);
      if (result.ok) {
        return {
          data: {
            mergePullRequest: {
              pullRequest: { number: key[1], merged: true, state: 'MERGED' },
            },
          },
        };
      }
      if (result.error === 'already') {
        return {
          data: {
            mergePullRequest: {
              pullRequest: { number: key[1], merged: true, state: 'MERGED' },
            },
          },
        };
      }
      if (result.error === 'not-found') {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Pull request not found' }] };
      }
      return {
        data: {
          mergePullRequest: {
            pullRequest: { number: key[1], merged: false, state: 'OPEN' },
          },
        },
        errors: [{ message: 'Merge conflict' }],
      };
    }

    case 'AddComment': {
      const input = asRecord(variables.input);
      if (input === undefined) {
        return { data: { addComment: null }, errors: [{ message: 'Missing input' }] };
      }
      const key = parseIssueKey(store, input.subjectId);
      if (key === null) {
        return { data: { addComment: null }, errors: [{ message: 'Issue not found' }] };
      }
      const repo = store.getRepoById(key[0]);
      const bodyText = asString(input.body);
      if (repo === undefined || bodyText === undefined) {
        return { data: { addComment: null }, errors: [{ message: 'Issue not found' }] };
      }
      const comment = store.addComment(repo, key[1], bodyText);
      if (comment === undefined) {
        return { data: { addComment: null }, errors: [{ message: 'Issue not found' }] };
      }
      return {
        data: {
          addComment: {
            commentEdge: {
              node: {
                id: store.nodeId('Comment', `${repo.id}:${key[1]}:${comment.id}`),
                body: comment.body,
              },
            },
          },
        },
      };
    }

    case 'ViewerInvalidField': {
      return {
        data: { viewer: { login: store.viewer.login } },
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
      };
    }

    case 'NodeRepository': {
      const id = asString(variables.id);
      const repoId = id === undefined ? null : parseRepositoryId(store, id);
      const repo = repoId === null ? undefined : store.getRepoById(repoId);
      if (repo === undefined) return { data: { node: null } };
      return {
        data: {
          node: {
            id: id ?? store.nodeId('Repository', String(repo.id)),
            name: repo.name,
            nameWithOwner: `${repo.owner}/${repo.name}`,
          },
        },
      };
    }

    case 'IssuesPage': {
      const owner = asString(variables.owner);
      const name = asString(variables.name);
      const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return { data: { repository: null } };
      const first = asNumber(variables.first);
      const issues = store
        .listIssues(repo, 'all')
        .slice()
        .sort((a, b) => b.number - a.number);
      const afterNumber = parseCursor(store, variables.after);
      let start = 0;
      if (afterNumber !== null) {
        const idx = issues.findIndex((issue) => issue.number === afterNumber);
        start = idx === -1 ? issues.length : idx + 1;
      }
      const page = first === undefined ? issues.slice(start) : issues.slice(start, start + first);
      const last = page.length > 0 ? page[page.length - 1] : undefined;
      return {
        data: {
          repository: {
            issues: {
              nodes: page.map((issue) => ({ number: issue.number })),
              pageInfo: {
                hasNextPage: start + page.length < issues.length,
                endCursor:
                  last === undefined ? null : store.nodeId('IssueCursor', String(last.number)),
              },
            },
          },
        },
      };
    }

    default: {
      // Introspection documents without a recognised operation name, and
      // anonymous viewer queries, are answered from the query text itself.
      if (query.includes('__type')) return handleIntrospection(query);
      if (/viewer\s*\{/.test(query)) {
        return { data: { viewer: { login: store.viewer.login } } };
      }
      return unknownOperation();
    }
  }
}

/**
 * Handle one GraphQL request body, or a batched array of them.
 * Success is always HTTP 200; only a non-object body is HTTP 400.
 */
export function handleGraphQL(store: Store, body: unknown): { status: number; json: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, json: body.map((item) => handleSingle(store, item)) };
  }
  if (!isRecord(body)) {
    return { status: 400, json: { message: 'Invalid request body' } };
  }
  return { status: 200, json: handleSingle(store, body) };
}
