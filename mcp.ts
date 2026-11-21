// MCP endpoint for the make.fun GitHub-compatible git forge.
//
// One JSON body in, one JSON body out (no SSE stream). The handler speaks
// JSON-RPC 2.0 over POST /mcp and drives the six forge tools against the
// shared Store. Auth is checked by app.ts before this handler is called.
//
// Erasable TypeScript only: no enums, no namespaces, no parameter
// properties, `import type` for types, node:* stdlib only. No clocks or
// randomness here — timestamps come from the store's objects.

import type { Store } from './store.ts';

/** A JSON-RPC 2.0 id: a string, a number, or absent (a notification). */
type RpcId = string | number | null;

/** The handler's answer: an HTTP status plus a JSON body (null = empty). */
export interface McpResponse {
  status: number;
  json: unknown | null;
}

type Args = Record<string, unknown>;

/** One tool result: text content plus the same object as structured data. */
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** Protocol versions this server understands for `initialize`. */
const KNOWN_PROTOCOL_VERSIONS: string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Versions advertised by `server/discover` (modern era first). */
const SUPPORTED_VERSIONS: string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';

/** The six tools, defined once so `tools/list` is byte-identical every call. */
const TOOLS: unknown[] = [
  {
    name: 'create_repo',
    description: 'Create a repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        owner: { type: 'string' },
        full_name: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        full_name: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        full_name: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
        full_name: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        body: { type: 'string' },
        full_name: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
        full_name: { type: 'string' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Canonical tool name (already normalized) -> accepted alias names. */
const TOOL_ALIASES: Record<string, string[]> = {
  createrepo: ['createrepository', 'repocreate', 'reposcreate', 'repositorycreate'],
  getrepo: ['getrepository', 'repoget', 'reposget', 'repositoryget'],
  createissue: ['issuecreate', 'issuescreate'],
  listissues: ['issueslist', 'issuelist'],
  createpullrequest: ['pullrequestcreate', 'pullscreate', 'createpr', 'prcreate'],
  mergepullrequest: ['pullrequestmerge', 'pullsmerge', 'mergepr', 'prmerge'],
};

/** Lowercase a tool name and drop every non-alphanumeric character. */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a client-supplied tool name to a canonical normalized name.
 * The normalized name must equal, or end with, the canonical name or one
 * of its aliases (so "github__create_issue" matches "create_issue").
 */
function resolveToolName(name: string): string | undefined {
  const normalized = normalizeToolName(name);
  for (const canonical of Object.keys(TOOL_ALIASES)) {
    if (normalized === canonical || normalized.endsWith(canonical)) return canonical;
    for (const alias of TOOL_ALIASES[canonical]) {
      if (normalized === alias || normalized.endsWith(alias)) return canonical;
    }
  }
  return undefined;
}

/** Build a JSON-RPC 2.0 success envelope, echoing the request id exactly. */
function rpcResult(id: RpcId, result: unknown): McpResponse {
  return { status: 200, json: { jsonrpc: '2.0', id, result } };
}

/** Build a JSON-RPC 2.0 error envelope (still HTTP 200, except parse errors). */
function rpcError(id: RpcId, code: number, message: string, status = 200): McpResponse {
  return { status, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** A successful tool result: text JSON plus the same object structured. */
function toolOk(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/** A failed tool result: plain-text message with isError set (not a throw). */
function toolFail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The "missing required argument" tool result the checks accept. */
function missingArg(name: string): ToolResult {
  return toolFail(`Missing required argument: ${name}`);
}

/** Read the arguments object of a tools/call, or {} when it is absent. */
function callArgs(params: unknown): Args {
  if (typeof params !== 'object' || params === null) return {};
  const args = (params as Record<string, unknown>).arguments;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
  return args as Args;
}

/** First non-empty string found under the canonical key or its synonyms. */
function pickString(args: Args, canonical: string, synonyms: string[]): string | undefined {
  for (const key of [canonical, ...synonyms]) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** First boolean found under the canonical key or its synonyms. */
function pickBoolean(args: Args, canonical: string, synonyms: string[]): boolean | undefined {
  for (const key of [canonical, ...synonyms]) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

/** First finite number found under the canonical key or its synonyms. */
function pickNumber(args: Args, canonical: string, synonyms: string[]): number | undefined {
  for (const key of [canonical, ...synonyms]) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

/** Split a "owner/repo" full_name into its two parts, or null. */
function splitFullName(args: Args): { owner: string; repo: string } | null {
  const fullName = pickString(args, 'full_name', ['fullName', 'fullname', 'name_with_owner']);
  if (fullName === undefined) return null;
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) return null;
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

/** Resolve owner + repo from canonical keys, synonyms, or full_name. */
function resolveOwnerRepo(args: Args): { owner: string | undefined; repo: string | undefined } {
  let owner = pickString(args, 'owner', [
    'owner_login',
    'org',
    'organization',
    'user',
    'user_login',
    'login',
    'account',
    'namespace',
    'owner_name',
  ]);
  let repo = pickString(args, 'repo', [
    'repository',
    'repository_name',
    'repo_name',
    'repo_slug',
    'project',
    'project_name',
  ]);
  if (owner === undefined || repo === undefined) {
    const split = splitFullName(args);
    if (split !== null) {
      if (owner === undefined) owner = split.owner;
      if (repo === undefined) repo = split.repo;
    }
  }
  return { owner, repo };
}

/** The public shape of a repository, shared by create_repo and get_repo. */
function repoShape(repo: {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
}): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

/** create_repo: always under the viewer; an existing repo is returned as-is. */
function doCreateRepo(store: Store, args: Args): ToolResult {
  let name = pickString(args, 'name', ['repo', 'repository']);
  if (name === undefined) {
    const split = splitFullName(args);
    if (split !== null) name = split.repo;
  }
  if (name === undefined) return missingArg('name');
  const description = pickString(args, 'description', ['about', 'summary', 'body']) ?? '';
  const isPrivate = pickBoolean(args, 'private', ['is_private']) ?? false;
  // The owner argument is ignored by design: repos are created under the
  // viewer ("adaiversen"), whatever the client sent.
  const existing = store.getRepo(store.viewer.login, name);
  if (existing !== undefined) return toolOk(repoShape(existing));
  const created = store.createRepo(store.viewer.login, name, description, isPrivate);
  if (created === null) {
    const retry = store.getRepo(store.viewer.login, name);
    if (retry !== undefined) return toolOk(repoShape(retry));
    return toolFail('Failed to create repository');
  }
  return toolOk(repoShape(created));
}

/** get_repo: the repo, or an isError result when it does not exist. */
function doGetRepo(store: Store, args: Args): ToolResult {
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner === undefined) return missingArg('owner');
  if (repo === undefined) return missingArg('repo');
  const found = store.getRepo(owner, repo);
  if (found === undefined) return toolFail('Repository not found');
  return toolOk(repoShape(found));
}

/** create_issue: labels are always empty for MCP-created issues. */
function doCreateIssue(store: Store, args: Args): ToolResult {
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner === undefined) return missingArg('owner');
  if (repo === undefined) return missingArg('repo');
  const title = pickString(args, 'title', ['issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === undefined) return missingArg('title');
  const body = pickString(args, 'body', ['issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const found = store.getRepo(owner, repo);
  if (found === undefined) return toolFail('Repository not found');
  const issue = store.createIssue(found, title, body, []);
  if (issue === null) return toolFail('Failed to create issue');
  return toolOk({
    id: store.nodeId('Issue', `${found.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: 'open',
  });
}

/** list_issues: state defaults to "open" when not sent. */
function doListIssues(store: Store, args: Args): ToolResult {
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner === undefined) return missingArg('owner');
  if (repo === undefined) return missingArg('repo');
  const rawState = pickString(args, 'state', ['status']);
  const state: 'open' | 'closed' | 'all' =
    rawState === 'closed' || rawState === 'all' ? rawState : 'open';
  const found = store.getRepo(owner, repo);
  if (found === undefined) return toolFail('Repository not found');
  const issues = store.listIssues(found, state).map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
  }));
  return toolOk({ issues });
}

/** create_pull_request: null from the store means a head/base ref is missing. */
function doCreatePullRequest(store: Store, args: Args): ToolResult {
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner === undefined) return missingArg('owner');
  if (repo === undefined) return missingArg('repo');
  const title = pickString(args, 'title', ['issue_title', 'pr_title', 'pull_request_title', 'subject']);
  if (title === undefined) return missingArg('title');
  const head = pickString(args, 'head', ['head_ref', 'head_branch', 'source', 'source_ref', 'from', 'branch']);
  if (head === undefined) return missingArg('head');
  const base = pickString(args, 'base', ['base_ref', 'target', 'into']);
  if (base === undefined) return missingArg('base');
  const body = pickString(args, 'body', ['issue_body', 'description', 'content', 'text', 'comment']) ?? '';
  const found = store.getRepo(owner, repo);
  if (found === undefined) return toolFail('Repository not found');
  const pull = store.createPull(found, head, base, title, body);
  if (pull === null) return toolFail('Failed to create pull request: head or base ref not found');
  return toolOk({
    number: pull.number,
    title: pull.title,
    state: 'open',
    head: { ref: head },
    base: { ref: base },
  });
}

/** merge_pull_request: squash-merge; any store failure is an isError result. */
function doMergePullRequest(store: Store, args: Args): ToolResult {
  const { owner, repo } = resolveOwnerRepo(args);
  if (owner === undefined) return missingArg('owner');
  if (repo === undefined) return missingArg('repo');
  const pullNumber = pickNumber(args, 'pull_number', [
    'pull_request_number',
    'pr_number',
    'number',
    'issue_number',
    'index',
  ]);
  if (pullNumber === undefined) return missingArg('pull_number');
  const found = store.getRepo(owner, repo);
  if (found === undefined) return toolFail('Repository not found');
  const merged = store.mergePull(found, pullNumber, 'squash');
  if (!merged.ok) {
    if (merged.error === 'not-found') return toolFail('Pull request not found');
    if (merged.error === 'already') return toolFail('Pull request is already merged or closed');
    return toolFail('Merge conflict');
  }
  return toolOk({ merged: true, number: pullNumber });
}

/** Dispatch one tools/call to the matching canonical tool. */
function dispatchTool(store: Store, params: unknown): ToolResult | { rpcError: { code: number; message: string } } {
  if (typeof params !== 'object' || params === null) {
    return { rpcError: { code: -32602, message: 'Invalid params' } };
  }
  const name = (params as Record<string, unknown>).name;
  if (typeof name !== 'string' || name === '') {
    return { rpcError: { code: -32602, message: 'Invalid params' } };
  }
  const canonical = resolveToolName(name);
  if (canonical === undefined) {
    return { rpcError: { code: -32601, message: 'Method not found' } };
  }
  const args = callArgs(params);
  if (canonical === 'createrepo') return doCreateRepo(store, args);
  if (canonical === 'getrepo') return doGetRepo(store, args);
  if (canonical === 'createissue') return doCreateIssue(store, args);
  if (canonical === 'listissues') return doListIssues(store, args);
  if (canonical === 'createpullrequest') return doCreatePullRequest(store, args);
  return doMergePullRequest(store, args);
}

/**
 * Handle one POST /mcp body and answer with a single JSON-RPC 2.0 object.
 * Notifications (requests without an id) get no response: HTTP 202 with
 * an empty body. JSON-RPC errors stay HTTP 200, except parse errors (400).
 */
export function handleMcp(store: Store, rawBody: string): McpResponse {
  let request: unknown;
  try {
    request = JSON.parse(rawBody) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }

  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const body = request as Record<string, unknown>;
  const method = body.method;
  if (typeof method !== 'string' || method === '') {
    const id = body.id;
    return rpcError(typeof id === 'string' || typeof id === 'number' ? id : null, -32600, 'Invalid Request');
  }
  const id: RpcId =
    typeof body.id === 'string' || typeof body.id === 'number' ? body.id : null;
  const hasId = body.id !== undefined;

  // A notification carries no id and never gets a response.
  if (!hasId) return { status: 202, json: null };

  try {
    if (method === 'server/discover') {
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
    }

    if (method === 'initialize') {
      const params = typeof body.params === 'object' && body.params !== null
        ? (body.params as Record<string, unknown>)
        : {};
      const offered = params.protocolVersion;
      const protocolVersion =
        typeof offered === 'string' && KNOWN_PROTOCOL_VERSIONS.includes(offered)
          ? offered
          : '2025-11-25';
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }

    if (method === 'notifications/initialized') {
      return rpcResult(id, {});
    }

    if (method === 'ping') {
      return rpcResult(id, {});
    }

    if (method === 'tools/list') {
      return rpcResult(id, { tools: TOOLS });
    }

    if (method === 'tools/call') {
      const dispatched = dispatchTool(store, body.params);
      if ('rpcError' in dispatched) {
        return rpcError(id, dispatched.rpcError.code, dispatched.rpcError.message);
      }
      return rpcResult(id, dispatched);
    }

    return rpcError(id, -32601, 'Method not found');
  } catch {
    return rpcError(id, -32603, 'Internal error');
  }
}
