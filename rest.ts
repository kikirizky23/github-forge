// REST v3 handler for the GitHub-compatible forge.
//
// One function, `handleRest`, answers every /api/v3 route the suite checks:
// users, repositories, branches, commits, git refs, contents, labels,
// issues, comments, pull requests, files and merges, plus rate_limit.
// Auth is already checked by app.ts before this is called; this module
// never checks tokens. It is deterministic: no Date.now, no Math.random,
// no `new Date` anywhere in a handler — timestamps come from the store.
//
// The store is supplied by the caller (see the Store contract in the task:
// viewer, getUser, createRepo, getRepo, deleteRepo, listRepos, getRepoById,
// listBranches, createRef, listCommits, commitFile, deleteFile, readPath,
// createLabel, getLabel, createIssue, getIssue, listIssues, closeIssue,
// addComment, createPull, getPull, listPulls, pullFiles, mergePull,
// nodeId, parseNodeId, nextRequestId). Only `import type` is used, so
// this file loads even when store.ts does not exist yet (types are erased).

import type { Issue, Pull, Repo, Store } from './store.ts';

type RestResult = { status: number; json: unknown; headers?: Record<string, string> };
type Body = Record<string, unknown>;

/** Build a result; the `headers` key is only present when there is one. */
function respond(status: number, json: unknown, headers?: Record<string, string>): RestResult {
  if (headers === undefined) return { status, json };
  return { status, json, headers };
}

function notFound(message = 'Not Found'): RestResult {
  return respond(404, { message });
}

function unprocessable(message: string): RestResult {
  return respond(422, { message });
}

/**
 * Parse a request body. An empty body is `{}`; a non-empty body that is
 * not a JSON object is malformed and must be answered 400.
 */
function parseBody(bodyText: string): { ok: true; body: Body } | { ok: false } {
  if (bodyText.trim() === '') return { ok: true, body: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, body: parsed as Body };
}

function strField(body: Body, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** A field that may be an array of label names, or of {name} objects. */
function labelNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Body).name === 'string') {
      names.push((item as Body).name as string);
    } else {
      return undefined;
    }
  }
  return names;
}

function hostOf(headers: Record<string, string>): string {
  return headers['host'] || headers['Host'] || 'localhost';
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const per = Number.parseInt(query.get('per_page') ?? '30', 10);
  const pg = Number.parseInt(query.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(per) && per > 0 ? per : 30,
    page: Number.isFinite(pg) && pg > 0 ? pg : 1,
  };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): { items: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

/** `<http://host/path?per_page=n&page=p+1>; rel="next"` (extra params kept). */
function nextLink(host: string, basePath: string, perPage: number, page: number, extra: Array<[string, string]> = []): string {
  const params = new URLSearchParams();
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  for (const [key, value] of extra) params.set(key, value);
  return `<http://${host}${basePath}?${params.toString()}>; rel="next"`;
}

function linkHeaders(host: string, basePath: string, perPage: number, page: number, hasNext: boolean, extra: Array<[string, string]> = []): Record<string, string> | undefined {
  if (!hasNext) return undefined;
  return { Link: nextLink(host, basePath, perPage, page, extra) };
}

/** Extra query params worth preserving when a list Link is followed. */
function preservedParams(query: URLSearchParams, keys: string[]): Array<[string, string]> {
  const extra: Array<[string, string]> = [];
  for (const key of keys) {
    const value = query.get(key);
    if (value !== null) extra.push([key, value]);
  }
  return extra;
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

function ownerJson(store: Store, login: string): { login: string; id: number; type: string } {
  const user = store.getUser(login);
  if (user !== undefined) return { login: user.login, id: user.id, type: user.type };
  if (login === store.viewer.login) return { login: store.viewer.login, id: store.viewer.id, type: store.viewer.type };
  return { login, id: 0, type: 'User' };
}

function repoJson(store: Store, repo: Repo): unknown {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: ownerJson(store, repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): unknown {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = store.getLabel(repo, name);
      return label === undefined ? { name } : { name: label.name, color: label.color };
    }),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(pull: Pull): unknown {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
  };
}

/** A repo the caller may read: missing repos and private repos of other owners read as absent. */
function findRepoForRead(store: Store, owner: string, name: string): Repo | undefined {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return undefined;
  if (owner !== store.viewer.login && repo.private) return undefined;
  return repo;
}

/** A repo the caller may write: only the viewer's own repos. */
function findRepoForWrite(store: Store, owner: string, name: string): Repo | undefined {
  if (owner !== store.viewer.login) return undefined;
  return store.getRepo(owner, name);
}

function baseName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Strip a "refs/heads/" prefix or an "owner:" fork prefix down to a short branch name. */
function shortBranch(ref: string): string {
  let out = ref;
  if (out.startsWith('refs/heads/')) out = out.slice('refs/heads/'.length);
  const colon = out.lastIndexOf(':');
  if (colon >= 0) out = out.slice(colon + 1);
  return out;
}

function parseNumber(text: string): number | undefined {
  if (!/^[0-9]+$/.test(text)) return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function handleRest(
  store: Store,
  method: string,
  path: string,
  query: URLSearchParams,
  headers: Record<string, string>,
  bodyText: string,
): RestResult {
  const segments = path.split('/').filter((s) => s.length > 0);
  // path always starts /api/v3 (root/meta are handled by app.ts); anything else is unknown.
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return notFound();
  const rest = segments.slice(2);
  const host = hostOf(headers);

  // A malformed JSON body on a mutating method is 400, before any routing.
  let body: Body = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = parseBody(bodyText);
    if (!parsed.ok) return respond(400, { message: 'Invalid JSON body' });
    body = parsed.body;
  }

  // 29. GET /api/v3/rate_limit — fixed numbers, never real time.
  if (rest.length === 1 && rest[0] === 'rate_limit') {
    if (method !== 'GET') return notFound();
    const bucket = { limit: 60, remaining: 60, reset: 1735689600 };
    return respond(200, { resources: { core: bucket }, rate: bucket });
  }

  // 1. GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return notFound();
    const viewer = store.viewer;
    return respond(200, {
      login: viewer.login,
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      type: viewer.type,
    });
  }

  // 2. POST /api/v3/user/repos — 3. GET /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = strField(body, 'name');
      if (name === undefined || name === '') return unprocessable('name is required');
      const description = strField(body, 'description') ?? '';
      const isPrivate = body['private'] === true;
      const repo = store.createRepo(store.viewer.login, name, description, isPrivate);
      if (repo === null) {
        return unprocessable(`Repository ${name} already exists for ${store.viewer.login}`);
      }
      return respond(201, repoJson(store, repo));
    }
    if (method === 'GET') {
      const { perPage, page } = pageParams(query);
      const repos = store.listRepos(store.viewer.login);
      const { items, hasNext } = paginate(repos, perPage, page);
      return respond(
        200,
        items.map((repo) => repoJson(store, repo)),
        linkHeaders(host, '/api/v3/user/repos', perPage, page, hasNext),
      );
    }
    return notFound();
  }

  // 4. GET /api/v3/users/{login}/repos
  if (rest.length === 3 && rest[0] === 'users' && rest[2] === 'repos') {
    if (method !== 'GET') return notFound();
    const login = rest[1] as string;
    if (store.getUser(login) === undefined) return notFound('User not found');
    const { perPage, page } = pageParams(query);
    const repos = store.listRepos(login);
    const { items, hasNext } = paginate(repos, perPage, page);
    return respond(
      200,
      items.map((repo) => repoJson(store, repo)),
      linkHeaders(host, `/api/v3/users/${login}/repos`, perPage, page, hasNext),
    );
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    const tail = rest.slice(3);
    return handleRepoRoute(store, method, query, host, body, owner, repoName, tail);
  }

  // 30. Anything else under /api/v3 is unknown.
  return notFound();
}

function handleRepoRoute(
  store: Store,
  method: string,
  query: URLSearchParams,
  host: string,
  body: Body,
  owner: string,
  repoName: string,
  tail: string[],
): RestResult {
  const basePath = `/api/v3/repos/${owner}/${repoName}`;

  // 5. GET /repos/{o}/{r} — 6. PATCH — 7. DELETE
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = findRepoForRead(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      return respond(200, repoJson(store, repo));
    }
    if (method === 'PATCH') {
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const description = strField(body, 'description');
      if (description !== undefined) repo.description = description;
      return respond(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      if (!store.deleteRepo(owner, repoName)) return notFound('Repository not found');
      return respond(204, null);
    }
    return notFound();
  }

  // 8. GET /repos/{o}/{r}/branches — 9. GET /repos/{o}/{r}/branches/{branch}
  if (tail[0] === 'branches') {
    if (method !== 'GET') return notFound();
    const repo = findRepoForRead(store, owner, repoName);
    if (repo === undefined) return notFound('Repository not found');
    const branches = store.listBranches(repo);
    if (tail.length === 1) {
      return respond(200, branches.map((b) => ({ name: b.name, commit: { sha: b.sha } })));
    }
    const branchName = tail.slice(1).join('/');
    const branch = branches.find((b) => b.name === branchName);
    if (branch === undefined) return notFound('Branch not found');
    return respond(200, { name: branch.name, commit: { sha: branch.sha } });
  }

  // 10. GET /repos/{o}/{r}/commits
  if (tail.length === 1 && tail[0] === 'commits') {
    if (method !== 'GET') return notFound();
    const repo = findRepoForRead(store, owner, repoName);
    if (repo === undefined) return notFound('Repository not found');
    const ref = query.get('sha') ?? undefined;
    const commits = store.listCommits(repo, ref);
    return respond(200, commits.map((c) => ({ sha: c.sha, commit: { message: c.message } })));
  }

  // 11. POST /repos/{o}/{r}/git/refs — 12. GET /repos/{o}/{r}/git/refs/heads/{branch}
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const ref = strField(body, 'ref');
      const sha = strField(body, 'sha');
      if (ref === undefined || ref === '' || sha === undefined || sha === '') {
        return unprocessable('ref and sha are required');
      }
      if (!store.createRef(repo, ref, sha)) {
        return unprocessable('Reference already exists or sha is unknown');
      }
      return respond(201, { ref, object: { sha } });
    }
    if (tail.length >= 4 && tail[2] === 'heads' && method === 'GET') {
      const repo = findRepoForRead(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const branchName = tail.slice(3).join('/');
      const branch = store.listBranches(repo).find((b) => b.name === branchName);
      if (branch === undefined) return notFound('Reference not found');
      return respond(200, { ref: `refs/heads/${branchName}`, object: { sha: branch.sha } });
    }
    return notFound();
  }

  // 13. PUT — 14. GET — 15. DELETE /repos/{o}/{r}/contents/{path...}
  if (tail[0] === 'contents') {
    const contentPath = tail.slice(1).join('/');
    if (method === 'PUT') {
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const content = strField(body, 'content');
      if (content === undefined) return unprocessable('content is required');
      const message = strField(body, 'message') ?? '';
      const branch = strField(body, 'branch');
      const sha = strField(body, 'sha');
      const result = store.commitFile(repo, { path: contentPath, contentB64: content, message, branch, sha });
      if (!result.ok) {
        if (result.error === 'stale-sha') return respond(409, { message: 'sha does not match the current file' });
        if (result.error === 'no-sha') return unprocessable('sha is required to update an existing file');
        return notFound(result.error === 'no-branch' ? 'Branch not found' : 'File not found');
      }
      const size = Buffer.from(content, 'base64').length;
      return respond(result.created ? 201 : 200, {
        content: { name: baseName(contentPath), path: contentPath, sha: result.contentSha, size, encoding: 'base64' },
        commit: { sha: result.commitSha },
      });
    }
    if (method === 'GET') {
      const repo = findRepoForRead(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const ref = query.get('ref') ?? undefined;
      const found = store.readPath(repo, contentPath, ref);
      if (found === null) return notFound('Path not found');
      if (found.kind === 'file') {
        return respond(200, {
          type: 'file',
          encoding: 'base64',
          content: found.contentB64,
          sha: found.sha,
          size: found.size,
          name: baseName(contentPath),
          path: contentPath,
        });
      }
      return respond(
        200,
        found.entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.sha })),
      );
    }
    if (method === 'DELETE') {
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const sha = strField(body, 'sha');
      if (sha === undefined || sha === '') return unprocessable('sha is required');
      const message = strField(body, 'message') ?? '';
      const branch = strField(body, 'branch');
      const result = store.deleteFile(repo, { path: contentPath, message, sha, branch });
      if (!result.ok) {
        if (result.error === 'stale-sha') return respond(409, { message: 'sha does not match the current file' });
        return notFound(result.error === 'no-branch' ? 'Branch not found' : 'File not found');
      }
      return respond(200, { commit: { sha: result.commitSha } });
    }
    return notFound();
  }

  // 16. POST /repos/{o}/{r}/labels — 17. GET /repos/{o}/{r}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    if (method === 'POST') {
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const name = strField(body, 'name');
      const color = strField(body, 'color');
      if (name === undefined || name === '' || color === undefined) return unprocessable('name and color are required');
      const existing = store.getLabel(repo, name);
      if (existing !== undefined) return respond(200, { name: existing.name, color: existing.color });
      const label = store.createLabel(repo, name, color);
      return respond(201, { name: label.name, color: label.color });
    }
    if (method === 'GET') {
      const repo = findRepoForRead(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      return respond(200, repo.labels.map((l) => ({ name: l.name, color: l.color })));
    }
    return notFound();
  }

  // 18. POST /repos/{o}/{r}/issues — 19. GET /repos/{o}/{r}/issues
  if (tail.length === 1 && tail[0] === 'issues') {
    if (method === 'POST') {
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const title = strField(body, 'title');
      if (title === undefined || title === '') return unprocessable('title is required');
      const bodyText = strField(body, 'body') ?? '';
      const labels = labelNames(body['labels']) ?? [];
      for (const name of labels) {
        if (store.getLabel(repo, name) === undefined) return unprocessable(`Label ${name} does not exist`);
      }
      const issue = store.createIssue(repo, title, bodyText, labels);
      if (issue === null) return unprocessable('Label does not exist');
      return respond(201, issueJson(store, repo, issue));
    }
    if (method === 'GET') {
      const repo = findRepoForRead(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const stateParam = query.get('state') ?? 'open';
      const state = stateParam === 'closed' || stateParam === 'all' ? stateParam : 'open';
      const issues = store.listIssues(repo, state);
      const direction = query.get('direction') ?? 'asc';
      const ordered = direction === 'desc' ? [...issues].reverse() : issues;
      const { perPage, page } = pageParams(query);
      const { items, hasNext } = paginate(ordered, perPage, page);
      return respond(
        200,
        items.map((issue) => issueJson(store, repo, issue)),
        linkHeaders(host, `${basePath}/issues`, perPage, page, hasNext, preservedParams(query, ['state', 'sort', 'direction'])),
      );
    }
    return notFound();
  }

  // 20. GET /repos/{o}/{r}/issues/{n} — 21. PATCH
  // 22. POST /repos/{o}/{r}/issues/{n}/comments — 23. GET
  if (tail.length >= 2 && tail[0] === 'issues') {
    const n = parseNumber(tail[1] as string);
    if (n === undefined) return notFound();
    if (tail.length === 2) {
      if (method === 'GET') {
        const repo = findRepoForRead(store, owner, repoName);
        if (repo === undefined) return notFound('Repository not found');
        const issue = store.getIssue(repo, n);
        if (issue === undefined) return notFound('Issue not found');
        return respond(200, issueJson(store, repo, issue));
      }
      if (method === 'PATCH') {
        const repo = findRepoForWrite(store, owner, repoName);
        if (repo === undefined) return notFound('Repository not found');
        let issue = store.getIssue(repo, n);
        if (issue === undefined) return notFound('Issue not found');
        const state = strField(body, 'state');
        if (state === 'closed') {
          const closed = store.closeIssue(repo, n);
          if (closed !== undefined) issue = closed;
        } else if (state === 'open') {
          issue.state = 'open';
        }
        const title = strField(body, 'title');
        if (title !== undefined) issue.title = title;
        const bodyText = strField(body, 'body');
        if (bodyText !== undefined) issue.body = bodyText;
        const labels = labelNames(body['labels']);
        if (labels !== undefined) {
          for (const name of labels) {
            if (store.getLabel(repo, name) === undefined) return unprocessable(`Label ${name} does not exist`);
          }
          issue.labels = [...labels];
        }
        return respond(200, issueJson(store, repo, issue));
      }
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'POST') {
        const repo = findRepoForWrite(store, owner, repoName);
        if (repo === undefined) return notFound('Repository not found');
        if (store.getIssue(repo, n) === undefined) return notFound('Issue not found');
        const commentBody = strField(body, 'body');
        if (commentBody === undefined || commentBody === '') return unprocessable('body is required');
        const comment = store.addComment(repo, n, commentBody);
        if (comment === undefined) return notFound('Issue not found');
        return respond(201, { id: comment.id, body: comment.body, created_at: comment.createdAt });
      }
      if (method === 'GET') {
        const repo = findRepoForRead(store, owner, repoName);
        if (repo === undefined) return notFound('Repository not found');
        const issue = store.getIssue(repo, n);
        if (issue === undefined) return notFound('Issue not found');
        return respond(
          200,
          issue.comments.map((c) => ({ id: c.id, body: c.body, created_at: c.createdAt })),
        );
      }
      return notFound();
    }
    return notFound();
  }

  // 24. POST /repos/{o}/{r}/pulls — 25. GET /repos/{o}/{r}/pulls
  if (tail.length === 1 && tail[0] === 'pulls') {
    if (method === 'POST') {
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const head = strField(body, 'head');
      const base = strField(body, 'base');
      const title = strField(body, 'title');
      if (head === undefined || head === '' || base === undefined || base === '' || title === undefined || title === '') {
        return unprocessable('head, base and title are required');
      }
      const bodyText = strField(body, 'body') ?? '';
      const pull = store.createPull(repo, shortBranch(head), shortBranch(base), title, bodyText);
      if (pull === null) return unprocessable('head or base branch does not exist');
      return respond(201, pullJson(pull));
    }
    if (method === 'GET') {
      const repo = findRepoForRead(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const stateParam = query.get('state') ?? 'open';
      const state = stateParam === 'all' || stateParam === 'closed' ? stateParam : 'open';
      const pulls = store.listPulls(repo, state);
      const { perPage, page } = pageParams(query);
      const { items, hasNext } = paginate(pulls, perPage, page);
      return respond(
        200,
        items.map((pull) => pullJson(pull)),
        linkHeaders(host, `${basePath}/pulls`, perPage, page, hasNext, preservedParams(query, ['state'])),
      );
    }
    return notFound();
  }

  // 26. GET /repos/{o}/{r}/pulls/{n}
  // 27. GET /repos/{o}/{r}/pulls/{n}/files
  // 28. PUT /repos/{o}/{r}/pulls/{n}/merge
  if (tail.length >= 2 && tail[0] === 'pulls') {
    const n = parseNumber(tail[1] as string);
    if (n === undefined) return notFound();
    if (tail.length === 2) {
      if (method !== 'GET') return notFound();
      const repo = findRepoForRead(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const pull = store.getPull(repo, n);
      if (pull === undefined) return notFound('Pull request not found');
      return respond(200, pullJson(pull));
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (method !== 'GET') return notFound();
      const repo = findRepoForRead(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const pull = store.getPull(repo, n);
      if (pull === undefined) return notFound('Pull request not found');
      return respond(
        200,
        store.pullFiles(repo, pull).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
      );
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (method !== 'PUT') return notFound();
      const repo = findRepoForWrite(store, owner, repoName);
      if (repo === undefined) return notFound('Repository not found');
      const pull = store.getPull(repo, n);
      if (pull === undefined) return notFound('Pull request not found');
      const mergeMethod = strField(body, 'merge_method') ?? 'merge';
      const result = store.mergePull(repo, n, mergeMethod);
      if (!result.ok) {
        if (result.error === 'conflict') return respond(405, { message: 'Merge conflict' });
        if (result.error === 'already') return respond(405, { message: 'Pull request already merged' });
        return notFound('Pull request not found');
      }
      return respond(200, { merged: true, sha: result.sha, message: result.message });
    }
    return notFound();
  }

  // 30. Unknown route under /repos/{o}/{r}.
  return notFound();
}
