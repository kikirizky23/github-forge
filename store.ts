// In-memory store for the forge. Single source of truth for REST, GraphQL, MCP and git.
// Deterministic by construction: fixed timestamps, sequential ids, insertion order.
// No wall clock, no randomness anywhere in this file.
import {
  buildTreeFromPaths,
  countLineDiff,
  diffPathMaps,
  getTreeEntryOid,
  isAncestor,
  parseCommit,
  parseTree,
  putObjectIn,
  sha1Object,
  treeToPaths,
} from './git.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export interface GitObject {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  issueSeq: number;
  commentSeq: number;
  pullSeq: number;
}

const ZERO_OID = '0000000000000000000000000000000000000000';
/** Fixed "now": scenario epoch 2025-01-01T00:00:00Z. Never the wall clock. */
const NOW_SEC = 1735689600;
const NOW_ISO = '2025-01-01T00:00:00Z';
const AUTHOR_LINE = `adaiversen <adaiversen@example.invalid> ${NOW_SEC} +0000`;

export class Store {
  viewer: User;
  users: Map<string, User>;
  repos: Map<string, Repo>;
  nextRepoId: number;
  nextObjectId: number;
  requestSeq: number;
  nowIso: string;
  nowSec: number;

  constructor() {
    this.nowSec = NOW_SEC;
    this.nowIso = NOW_ISO;
    this.viewer = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
    this.users = new Map<string, User>();
    this.users.set('adaiversen', this.viewer);
    this.users.set('quinnkeller', { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' });
    this.users.set('olgabauer', { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' });
    this.users.set('faint-meadow-org', { id: 2000, login: 'faint-meadow-org', name: 'faint meadow org', email: 'faint-meadow-org@example.invalid', type: 'Organization' });
    this.repos = new Map<string, Repo>();
    this.nextRepoId = 5000;
    // Global numeric ids for issues and pull requests (GitHub's REST `id`):
    // one counter for both, so an issue and a pull request never share an id,
    // and the value is stable across reads and deterministic across runs.
    this.nextObjectId = 100000;
    this.requestSeq = 1;
  }

  getUser(login: string): User | undefined {
    return this.users.get(login);
  }

  nextRequestId(): string {
    const n = this.requestSeq;
    this.requestSeq += 1;
    return `req-${String(n).padStart(8, '0')}`;
  }

  nodeId(type: string, key: string): string {
    return Buffer.from(`GH:${type}:${key}`, 'utf8').toString('base64url');
  }

  parseNodeId(id: string): { type: string; key: string } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      if (!text.startsWith('GH:')) return null;
      const rest = text.slice(3);
      const idx = rest.indexOf(':');
      if (idx < 0) return null;
      return { type: rest.slice(0, idx), key: rest.slice(idx + 1) };
    } catch {
      return null;
    }
  }

  // ---- repos ----

  private repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.repoKey(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      refs: new Map<string, string>(),
      objects: new Map<string, GitObject>(),
      labels: [],
      issues: [],
      pulls: [],
      issueSeq: 1,
      commentSeq: 1,
      pullSeq: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) {
      if (repo.id === id) return repo;
    }
    return undefined;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  // ---- git objects / refs ----

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
  }

  deleteRef(repo: Repo, ref: string): boolean {
    return repo.refs.delete(ref);
  }

  listRefs(repo: Repo): Array<{ oid: string; ref: string }> {
    const out: Array<{ oid: string; ref: string }> = [];
    for (const [ref, oid] of repo.refs) out.push({ oid, ref });
    return out;
  }

  resolveHead(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    return putObjectIn(repo.objects, type, data);
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    return out;
  }

  createRef(repo: Repo, ref: string, sha: string): boolean {
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    return true;
  }

  private commitTreeOid(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  private makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    let text = `tree ${treeOid}\n`;
    for (const p of parents) text += `parent ${p}\n`;
    text += `author ${AUTHOR_LINE}\n`;
    text += `committer ${AUTHOR_LINE}\n`;
    text += `\n${message}`;
    return this.putObject(repo, 'commit', Buffer.from(text, 'utf8'));
  }

  listCommits(repo: Repo, ref?: string): Array<{ sha: string; message: string }> {
    let tip: string | undefined;
    if (ref === undefined || ref === '') {
      tip = this.resolveHead(repo);
    } else if (repo.refs.has(`refs/heads/${ref}`)) {
      tip = repo.refs.get(`refs/heads/${ref}`);
    } else if (repo.refs.has(ref)) {
      tip = repo.refs.get(ref);
    } else if (repo.objects.has(ref)) {
      tip = ref;
    }
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    let cur = tip;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') break;
      const c = parseCommit(obj.data);
      out.push({ sha: cur, message: c.message });
      cur = c.parents[0];
    }
    return out;
  }

  // ---- contents ----

  commitFile(
    repo: Repo,
    opts: { path: string; contentB64: string; message: string; branch?: string; sha?: string },
  ): { ok: true; contentSha: string; commitSha: string; created: boolean } | { ok: false; error: 'not-found' | 'stale-sha' | 'no-branch' | 'no-sha' } {
    const branchName = opts.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branchName}`;
    const tip = repo.refs.get(ref);
    if (opts.branch !== undefined && tip === undefined) return { ok: false, error: 'no-branch' };
    const content = Buffer.from(opts.contentB64, 'base64');
    let paths = new Map<string, string>();
    if (tip !== undefined) {
      const treeOid = this.commitTreeOid(repo, tip);
      if (treeOid === null) return { ok: false, error: 'not-found' };
      paths = treeToPaths(repo.objects, treeOid);
    }
    const existing = paths.get(opts.path);
    if (opts.sha !== undefined) {
      if (existing === undefined) return { ok: false, error: 'not-found' };
      if (opts.sha !== existing) return { ok: false, error: 'stale-sha' };
    } else if (existing !== undefined) {
      return { ok: false, error: 'no-sha' };
    }
    const created = existing === undefined;
    const blobOid = this.putObject(repo, 'blob', content);
    const next = new Map(paths);
    next.set(opts.path, blobOid);
    const treeOid = buildTreeFromPaths(repo.objects, next);
    const commitOid = this.makeCommit(repo, treeOid, tip !== undefined ? [tip] : [], opts.message);
    repo.refs.set(ref, commitOid);
    return { ok: true, contentSha: blobOid, commitSha: commitOid, created };
  }

  deleteFile(
    repo: Repo,
    opts: { path: string; message: string; sha: string; branch?: string },
  ): { ok: true; commitSha: string } | { ok: false; error: 'not-found' | 'stale-sha' | 'no-branch' } {
    const branchName = opts.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branchName}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) return { ok: false, error: 'not-found' };
    const treeOid = this.commitTreeOid(repo, tip);
    if (treeOid === null) return { ok: false, error: 'not-found' };
    const paths = treeToPaths(repo.objects, treeOid);
    const existing = paths.get(opts.path);
    if (existing === undefined) return { ok: false, error: 'not-found' };
    if (opts.sha !== existing) return { ok: false, error: 'stale-sha' };
    const next = new Map(paths);
    next.delete(opts.path);
    const newTreeOid = buildTreeFromPaths(repo.objects, next);
    const commitOid = this.makeCommit(repo, newTreeOid, [tip], opts.message);
    repo.refs.set(ref, commitOid);
    return { ok: true, commitSha: commitOid };
  }

  readPath(
    repo: Repo,
    path: string,
    ref?: string,
  ): { kind: 'file'; contentB64: string; sha: string; size: number } | { kind: 'dir'; entries: Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> } | null {
    const refName = ref ?? repo.defaultBranch;
    let tip: string | undefined;
    if (repo.refs.has(`refs/heads/${refName}`)) tip = repo.refs.get(`refs/heads/${refName}`);
    else if (repo.refs.has(refName)) tip = repo.refs.get(refName);
    else if (repo.objects.has(refName)) tip = refName;
    if (tip === undefined) return null;
    const treeOid = this.commitTreeOid(repo, tip);
    if (treeOid === null) return null;
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean === '') {
      const entries = parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)).map((e) => ({
        type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        name: e.name,
        path: e.name,
        sha: e.oid,
      }));
      return { kind: 'dir', entries };
    }
    const paths = treeToPaths(repo.objects, treeOid);
    const blobOid = paths.get(clean);
    if (blobOid !== undefined) {
      const obj = repo.objects.get(blobOid);
      if (!obj) return null;
      return { kind: 'file', contentB64: obj.data.toString('base64'), sha: blobOid, size: obj.data.length };
    }
    // directory?
    const prefix = `${clean}/`;
    const children = new Map<string, { type: 'file' | 'dir'; sha: string }>();
    for (const [p, oid] of paths) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (rest.includes('/')) {
        if (!children.has(seg)) {
          const subOid = getTreeEntryOid(repo.objects, treeOid, clean.split('/').concat([seg]));
          children.set(seg, { type: 'dir', sha: subOid ?? '' });
        }
      } else {
        children.set(seg, { type: 'file', sha: oid });
      }
    }
    if (children.size === 0) return null;
    const entries = [...children.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, v]) => ({ type: v.type, name, path: `${clean}/${name}`, sha: v.sha }));
    return { kind: 'dir', entries };
  }

  // ---- labels / issues ----

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.find((l) => l.name === name);
    if (existing) return existing;
    const label: Label = { name, color };
    repo.labels.push(label);
    return label;
  }

  getLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.find((l) => l.name === name);
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | null {
    for (const name of labels) {
      if (!this.getLabel(repo, name)) return null;
    }
    const issue: Issue = {
      id: this.nextObjectId,
      number: repo.issueSeq,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    };
    this.nextObjectId += 1;
    repo.issueSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, n: number): Issue | undefined {
    return repo.issues.find((i) => i.number === n);
  }

  listIssues(repo: Repo, state: 'open' | 'closed' | 'all'): Issue[] {
    if (state === 'all') return [...repo.issues];
    return repo.issues.filter((i) => i.state === state);
  }

  closeIssue(repo: Repo, n: number): Issue | undefined {
    const issue = this.getIssue(repo, n);
    if (!issue) return undefined;
    issue.state = 'closed';
    issue.updatedAt = this.nowIso;
    return issue;
  }

  addComment(repo: Repo, n: number, body: string): IssueComment | undefined {
    const issue = this.getIssue(repo, n);
    if (!issue) return undefined;
    const comment: IssueComment = { id: repo.commentSeq, body, createdAt: this.nowIso };
    repo.commentSeq += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ---- pull requests ----

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const pr: Pull = {
      id: this.nextObjectId,
      number: repo.pullSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      createdAt: this.nowIso,
    };
    this.nextObjectId += 1;
    repo.pullSeq += 1;
    repo.pulls.push(pr);
    return pr;
  }

  getPull(repo: Repo, n: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === n);
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): Pull[] {
    if (state === 'all') return [...repo.pulls];
    return repo.pulls.filter((p) => p.state === state);
  }

  pullFiles(repo: Repo, pr: Pull): PullFile[] {
    const baseTree = this.commitTreeOid(repo, pr.baseSha);
    const headTree = this.commitTreeOid(repo, pr.headSha);
    const basePaths = baseTree === null ? new Map<string, string>() : treeToPaths(repo.objects, baseTree);
    const headPaths = headTree === null ? new Map<string, string>() : treeToPaths(repo.objects, headTree);
    const out: PullFile[] = [];
    for (const d of diffPathMaps(basePaths, headPaths)) {
      const oldData = d.oldOid !== undefined ? repo.objects.get(d.oldOid)?.data : undefined;
      const newData = d.newOid !== undefined ? repo.objects.get(d.newOid)?.data : undefined;
      const { additions, deletions } = countLineDiff(oldData, newData);
      out.push({ filename: d.path, status: d.status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  private findMergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA = [a];
    while (stackA.length > 0) {
      const cur = stackA.pop() as string;
      if (ancestorsA.has(cur)) continue;
      ancestorsA.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stackA.push(p);
    }
    const stackB = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const cur = stackB.pop() as string;
      if (seenB.has(cur)) continue;
      seenB.add(cur);
      if (ancestorsA.has(cur)) return cur;
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stackB.push(p);
    }
    return null;
  }

  mergePull(repo: Repo, n: number, _method: string): { ok: true; sha: string; message: string } | { ok: false; error: 'not-found' | 'conflict' | 'already' } {
    const pr = this.getPull(repo, n);
    if (!pr) return { ok: false, error: 'not-found' };
    if (pr.merged || pr.state !== 'open') return { ok: false, error: 'already' };
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`);
    if (baseTip === undefined) return { ok: false, error: 'not-found' };
    const headTree = this.commitTreeOid(repo, pr.headSha);
    const baseTree = this.commitTreeOid(repo, baseTip);
    if (headTree === null || baseTree === null) return { ok: false, error: 'not-found' };
    const mergeBase = this.findMergeBase(repo, baseTip, pr.headSha);
    const basePaths = treeToPaths(repo.objects, baseTree);
    const headPaths = treeToPaths(repo.objects, headTree);
    const ancestorPaths = mergeBase === null ? new Map<string, string>() : treeToPaths(repo.objects, this.commitTreeOid(repo, mergeBase) as string);
    // Three-way conflict: path changed on both sides (vs ancestor) to different results.
    const allPaths = new Set<string>([...ancestorPaths.keys(), ...basePaths.keys(), ...headPaths.keys()]);
    for (const p of allPaths) {
      const a = ancestorPaths.get(p);
      const b = basePaths.get(p);
      const h = headPaths.get(p);
      const changedBase = a !== b;
      const changedHead = a !== h;
      if (changedBase && changedHead && b !== h) {
        return { ok: false, error: 'conflict' };
      }
    }
    const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
    const commitOid = this.makeCommit(repo, headTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.nowIso;
    pr.mergeCommitSha = commitOid;
    return { ok: true, sha: commitOid, message };
  }
}

export { ZERO_OID, sha1Object };
