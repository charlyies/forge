// store.ts — the forge's in-memory model: repositories, git refs, issues, pull requests.
import { buildTree, hashObject, ObjStore, parseCommit, parseTree, type GitObject, type ObjType } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface Label { id: number; name: string; color: string; description: string }
export interface Comment { id: number; body: string; user: string; created_at: string; updated_at: string }
export interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; user: string; created_at: string; updated_at: string; comments: Comment[];
}
export interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  merged: boolean; mergeable: boolean; merge_commit_sha: string | null; merged_at: string | null;
  user: string; created_at: string; updated_at: string;
}
export interface Repo {
  id: number; name: string; owner: string; isPrivate: boolean; description: string;
  defaultBranch: string; created_at: string; updated_at: string;
  store: ObjStore; refs: Map<string, string>;
  labels: Map<string, Label>; issues: Issue[]; pulls: Pull[];
  counter: number; labelCounter: number; commentCounter: number;
}

let repoIdCounter = 5000;
let clockSeq = 1735689600;
function nextTs(): number { clockSeq += 1; return clockSeq; }
export function isoNow(): string {
  return new Date(nextTs() * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function ident(): string {
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${nextTs()} +0000`;
}

export class Forge {
  repos = new Map<string, Repo>();
  key(owner: string, name: string): string { return `${owner}/${name}`; }
  getRepo(owner: string, name: string): Repo | undefined { return this.repos.get(this.key(owner, name)); }
  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }
  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const now = isoNow();
    const repo: Repo = {
      id: repoIdCounter++, name, owner: VIEWER_LOGIN, isPrivate, description,
      defaultBranch: 'main', created_at: now, updated_at: now,
      store: new ObjStore(), refs: new Map(),
      labels: new Map(), issues: [], pulls: [],
      counter: 0, labelCounter: 0, commentCounter: 0,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }
  deleteRepo(owner: string, name: string): boolean { return this.repos.delete(this.key(owner, name)); }

  // ------------------------------------------------------------ git helpers
  /** Build a tree from a base tree, applying path -> blob bytes (null = delete). */
  applyToTree(store: ObjStore, baseTreeOid: string | null, changes: Map<string, Buffer | null>): string {
    const apply = (treeOid: string | null, parts: string[], data: Buffer | null, mode: string): string | null => {
      const entries = new Map<string, { mode: string; oid: string }>();
      if (treeOid) {
        const tree = store.get(treeOid);
        if (tree?.type === 'tree') for (const e of parseTree(tree.data)) entries.set(e.name, { mode: e.mode, oid: e.oid });
      }
      const [head, ...rest] = parts;
      if (rest.length === 0) {
        if (data === null) entries.delete(head!);
        else entries.set(head!, { mode, oid: store.put('blob', data) });
      } else {
        const child = entries.get(head!);
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const next = apply(childTree, rest, data, mode);
        if (next === null) entries.delete(head!);
        else entries.set(head!, { mode: '40000', oid: next });
      }
      if (entries.size === 0) return null;
      return store.put('tree', buildTree([...entries.entries()].map(([name, e]) => ({ mode: e.mode, name, oid: e.oid }))));
    };
    let current: string | null = baseTreeOid;
    // Apply each change through the recursive helper rooted at the current tree.
    for (const [path, data] of changes) {
      const parts = path.split('/').filter((p) => p !== '');
      if (parts.length === 0) continue;
      current = apply(current, parts, data, '100644');
      if (current === null) {
        // Tree became empty: represent as the empty tree object.
        current = store.put('tree', buildTree([]));
      }
    }
    return current ?? store.put('tree', buildTree([]));
  }

  commitObject(store: ObjStore, tree: string, parents: string[], message: string): string {
    const who = ident();
    const lines = [`tree ${tree}`];
    for (const p of parents) lines.push(`parent ${p}`);
    lines.push(`author ${who}`, `committer ${who}`, '', message);
    return store.put('commit', Buffer.from(lines.join('\n') + '\n', 'utf8'));
  }

  /** Commit one file change on a branch; creates the branch/commit chain as needed. */
  commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; contentSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    let baseTree: string | null = null;
    const parents: string[] = [];
    if (tip) {
      const commit = repo.store.get(repo.store.peel(tip));
      if (commit?.type === 'commit') {
        baseTree = parseCommit(commit.data).tree;
        parents.push(repo.store.peel(tip));
      }
    }
    const tree = this.applyToTree(repo.store, baseTree, new Map([[path, content]]));
    const commitSha = this.commitObject(repo.store, tree, parents, message);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: hashObject('blob', content) };
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) throw new Error('branch has no commits');
    const commit = repo.store.get(repo.store.peel(tip));
    if (!commit || commit.type !== 'commit') throw new Error('branch tip is not a commit');
    const baseTree = parseCommit(commit.data).tree;
    const tree = this.applyToTree(repo.store, baseTree, new Map([[path, null]]));
    const commitSha = this.commitObject(repo.store, tree, [repo.store.peel(tip)], message);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  /** Read a file's bytes at a ref (branch name, sha, or default branch). Returns null when absent. */
  readFile(repo: Repo, ref: string | undefined, path: string): { data: Buffer; sha: string; size: number } | null {
    let tip: string | undefined;
    if (!ref) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    else if (repo.refs.has(`refs/heads/${ref}`)) tip = repo.refs.get(`refs/heads/${ref}`);
    else if (repo.refs.has(ref)) tip = repo.refs.get(ref);
    else if (repo.store.get(ref)?.type === 'commit' || repo.store.get(ref)?.type === 'tag') tip = ref;
    if (!tip) return null;
    const files = repo.store.fileMap(tip);
    const entry = files.get(path);
    if (!entry) return null;
    const blob = repo.store.get(entry.oid);
    if (!blob) return null;
    return { data: blob.data, sha: entry.oid, size: blob.data.length };
  }

  /** List directory entries at a ref and path ('' = root). Null when the path is not a directory. */
  listDir(repo: Repo, ref: string | undefined, path: string): Array<{ name: string; path: string; sha: string; type: 'file' | 'dir'; size: number }> | null {
    let tip: string | undefined;
    if (!ref) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    else if (repo.refs.has(`refs/heads/${ref}`)) tip = repo.refs.get(`refs/heads/${ref}`);
    else if (repo.refs.has(ref)) tip = repo.refs.get(ref);
    else if (repo.store.get(ref)) tip = ref;
    if (!tip) return null;
    const commit = repo.store.get(repo.store.peel(tip));
    if (!commit || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    if (path !== '') {
      for (const part of path.split('/')) {
        const tree = repo.store.get(treeOid);
        if (!tree || tree.type !== 'tree') return null;
        const entry = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
        if (!entry) return null;
        treeOid = entry.oid;
      }
    }
    const tree = repo.store.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    return parseTree(tree.data).map((e) => {
      const size = e.mode === '40000' ? 0 : (repo.store.get(e.oid)?.data.length ?? 0);
      return { name: e.name, path: path ? `${path}/${e.name}` : e.name, sha: e.oid, type: e.mode === '40000' ? 'dir' as const : 'file' as const, size };
    });
  }

  // ------------------------------------------------------------ issues / PRs
  nextNumber(repo: Repo): number { repo.counter += 1; return repo.counter; }
  globalId(kind: string, repo: Repo, num: number): string {
    return Buffer.from(`${kind}:${repo.id}:${num}`, 'utf8').toString('base64url');
  }
  repoGlobalId(repo: Repo): string {
    return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url');
  }
  decodeGlobalId(id: string): { kind: string; repoId: number; num: number } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const parts = text.split(':');
      if (parts.length < 2) return null;
      return { kind: parts[0]!, repoId: Number(parts[1]), num: parts.length > 2 ? Number(parts[2]) : 0 };
    } catch { return null; }
  }
  findRepoById(id: number): Repo | undefined {
    return [...this.repos.values()].find((r) => r.id === id);
  }
  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label ${name} does not exist` };
      labels.push(label);
    }
    const number = this.nextNumber(repo);
    const now = isoNow();
    const issue: Issue = {
      id: 100000 + repo.id * 1000 + number, number, title, body: body ?? '', state: 'open',
      labels, user: VIEWER_LOGIN, created_at: now, updated_at: now, comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }
  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip) return { error: `head branch ${head} does not exist` };
    if (!baseTip) return { error: `base branch ${base} does not exist` };
    const number = this.nextNumber(repo);
    const now = isoNow();
    const pull: Pull = {
      id: 200000 + repo.id * 1000 + number, number, title, body: body ?? '', state: 'open',
      headRef: head, baseRef: base,
      headSha: repo.store.peel(headTip), baseSha: repo.store.peel(baseTip),
      merged: false, mergeable: true, merge_commit_sha: null, merged_at: null,
      user: VIEWER_LOGIN, created_at: now, updated_at: now,
    };
    pull.mergeable = this.prConflict(repo, pull) === null;
    repo.pulls.push(pull);
    return pull;
  }
  /** Files changed between base tip and head tip, with line counts. */
  prFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number; patch: string }> {
    const baseFiles = repo.store.fileMap(pull.baseSha);
    const headFiles = repo.store.fileMap(pull.headSha);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number; patch: string }> = [];
    for (const path of [...paths].sort()) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if (b && h && b.oid === h.oid) continue;
      const bText = b ? (repo.store.get(b.oid)?.data.toString('utf8') ?? '') : '';
      const hText = h ? (repo.store.get(h.oid)?.data.toString('utf8') ?? '') : '';
      const diff = lineDiff(bText, hText);
      const status = !b ? 'added' : !h ? 'removed' : 'modified';
      const patch = buildPatch(path, bText, hText, diff);
      out.push({ filename: path, status, additions: diff.added, deletions: diff.removed, changes: diff.added + diff.removed, patch });
    }
    return out;
  }
  /** The conflicting path for a 3-way merge of head onto base tip, or null. */
  prConflict(repo: Repo, pull: Pull): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return null;
    const basePeeled = repo.store.peel(baseTip);
    const mergeBase = repo.store.mergeBase(pull.headSha, basePeeled);
    if (!mergeBase) return null;
    const ancestorFiles = repo.store.fileMap(mergeBase);
    const currentFiles = repo.store.fileMap(basePeeled);
    const headFiles = repo.store.fileMap(pull.headSha);
    const paths = new Set([...ancestorFiles.keys(), ...currentFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path)?.oid;
      const c = currentFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      const headChanged = h !== a;
      const currentChanged = c !== a;
      if (headChanged && currentChanged && h !== c) return path;
    }
    return null;
  }
  /** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or an error. */
  mergePull(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
    if (pull.state === 'closed') return { error: 'pull request is already closed', status: 405 };
    const conflict = this.prConflict(repo, pull);
    if (conflict !== null) return { error: `merge conflict on ${conflict}`, status: 405 };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) return { error: 'base branch does not exist', status: 422 };
    const basePeeled = repo.store.peel(baseTip);
    const baseCommit = repo.store.get(basePeeled);
    if (!baseCommit || baseCommit.type !== 'commit') return { error: 'base tip is not a commit', status: 422 };
    const baseTree = parseCommit(baseCommit.data).tree;
    const changes = new Map<string, Buffer | null>();
    const headFiles = repo.store.fileMap(pull.headSha);
    const baseFiles = repo.store.fileMap(basePeeled);
    const mergeBase = repo.store.mergeBase(pull.headSha, basePeeled);
    const ancestorFiles = mergeBase ? repo.store.fileMap(mergeBase) : new Map();
    const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const a = ancestorFiles.get(path)?.oid;
      const h = headFiles.get(path)?.oid;
      if (h === a) continue;
      if (h === undefined) changes.set(path, null);
      else {
        const blob = repo.store.get(h);
        if (blob) changes.set(path, blob.data);
      }
    }
    void baseFiles;
    const tree = this.applyToTree(repo.store, baseTree, changes);
    const message = `${pull.title} (#${pull.number})`;
    const sha = this.commitObject(repo.store, tree, [basePeeled], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = sha;
    pull.merged_at = isoNow();
    pull.updated_at = pull.merged_at;
    return { sha };
  }
}

// ------------------------------------------------------------ line diff (LCS, small files)
export function lineDiff(oldText: string, newText: string): { added: number; removed: number; ops: Array<{ kind: ' ' | '+' | '-'; line: string }> } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (oldText.endsWith('\n') && a.length && a[a.length - 1] === '') a.pop();
  if (newText.endsWith('\n') && b.length && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Array<{ kind: ' ' | '+' | '-'; line: string }> = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: ' ', line: a[i]! }); i += 1; j += 1; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { ops.push({ kind: '-', line: a[i]! }); removed += 1; i += 1; }
    else { ops.push({ kind: '+', line: b[j]! }); added += 1; j += 1; }
  }
  while (i < n) { ops.push({ kind: '-', line: a[i]! }); removed += 1; i += 1; }
  while (j < m) { ops.push({ kind: '+', line: b[j]! }); added += 1; j += 1; }
  return { added, removed, ops };
}
function buildPatch(path: string, oldText: string, newText: string, diff: { added: number; removed: number; ops: Array<{ kind: ' ' | '+' | '-'; line: string }> }): string {
  const oldLines = oldText === '' ? 0 : oldText.split('\n').length - (oldText.endsWith('\n') ? 1 : 0);
  const newLines = newText === '' ? 0 : newText.split('\n').length - (newText.endsWith('\n') ? 1 : 0);
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${oldLines} +1,${newLines} @@`];
  for (const op of diff.ops) lines.push(`${op.kind}${op.line}`);
  return lines.join('\n');
}

export type { GitObject, ObjType };
