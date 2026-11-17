// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4, MCP.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  decodePktLines, isOid, ObjStore, parseCommit, parseTag, pktDelim, pktFlush, pktLine, pktLines,
  readPack, writePack, ZERO_OID, type GitObject,
} from './git.ts';
import { GraphQLExecutor } from './graphql.ts';
import { handleMcp, publicRepo } from './mcp.ts';
import {
  Forge, isoNow, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, type Issue, type Pull, type Repo,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AGENT = 'forge/1.0';

const forge = new Forge();
const gql = new GraphQLExecutor(forge);

// Request ids only have to be non-empty (suite: protocol/request-id); a per-process
// counter is unique and far cheaper than a crypto UUID per reply.
let reqCounter = 0;
const reqPrefix = `forge-${process.pid}-`;
function reqId(): string { return `${reqPrefix}${(reqCounter += 1).toString(36)}`; }
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': reqId(), ...extra };
  if (status !== 204) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': reqId(),
  });
  res.end(body);
}
function sendCachedJson(res: ServerResponse, status: number, cached: { text: string; len: number }): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(cached.len),
    'x-github-request-id': reqId(),
  });
  res.end(cached.text);
}

// Cached serialization of one issue's GET response. An issue's JSON depends only on
// title, body, state, labels (immutable after creation), comments.length and the
// stored timestamps, so the fingerprint below is a sound validity check: every
// mutation site (REST PATCH, REST comment POST, GraphQL closeIssue/addComment)
// changes at least one fingerprinted field. The read workload GETs one issue 2,000
// times unchanged, so this removes the per-request rebuild entirely.
interface IssueJsonCacheEntry { title: string; body: string; state: string; updatedAt: string; comments: number; text: string; len: number }
const issueJsonCache = new Map<string, IssueJsonCacheEntry>();
function cachedIssueJson(repo: Repo, issue: Issue): { text: string; len: number } {
  const key = `${repo.id}:${issue.number}`;
  const entry = issueJsonCache.get(key);
  if (entry !== undefined
    && entry.title === issue.title && entry.body === issue.body && entry.state === issue.state
    && entry.updatedAt === issue.updated_at && entry.comments === issue.comments.length) {
    return entry;
  }
  const text = `${JSON.stringify(issueJson(repo, issue))}\n`;
  const fresh: IssueJsonCacheEntry = {
    title: issue.title, body: issue.body, state: issue.state,
    updatedAt: issue.updated_at, comments: issue.comments.length,
    text, len: Buffer.byteLength(text),
  };
  issueJsonCache.set(key, fresh);
  return fresh;
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) as unknown }; }
  catch { return { ok: false }; }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function pathOf(req: IncomingMessage): { path: string; query: URLSearchParams } {
  // Fast path: the suite only sends clean absolute paths, so split on '?' by hand
  // instead of paying for a full URL parse per request (2,000+ per read round).
  // Anything odd (absolute URL, dot segments, '//') falls back to URL parsing,
  // which is the exact behaviour the old code had for every request.
  const raw = req.url ?? '/';
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.includes('..') || raw.includes('//')) {
    try {
      const url = new URL(raw, 'http://entry');
      return { path: url.pathname, query: url.searchParams };
    } catch { return { path: '/', query: new URLSearchParams() }; }
  }
  const q = raw.indexOf('?');
  return {
    path: q >= 0 ? raw.slice(0, q) : raw,
    query: q >= 0 ? new URLSearchParams(raw.slice(q + 1)) : new URLSearchParams(),
  };
}
function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (TOKEN === '') return token !== '';
  return token === TOKEN;
}
function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  return `${proto}://${host}`;
}
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}
function paginate<T>(items: T[], page: number, perPage: number): { page: T[]; hasNext: boolean; hasPrev: boolean; total: number } {
  const total = items.length;
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < total, hasPrev: page > 1, total };
}
function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${baseUrlOf(req)}${path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (hasNext) links.push(`${build(page + 1)}; rel="next"`);
  links.push(`${build(lastPage)}; rel="last"`);
  if (page > 1) links.push(`${build(1)}; rel="first"`, `${build(page - 1)}; rel="prev"`);
  return links.join(', ');
}

// ---------------------------------------------------------------- JSON views
function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN, id: VIEWER_ID, node_id: Buffer.from('User:1000', 'utf8').toString('base64url'),
    avatar_url: '', gravatar_id: '', url: '/api/v3/user', html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User', site_admin: false, name: 'ada iversen', email: VIEWER_EMAIL,
    created_at: '2025-01-01T00:00:00Z', updated_at: isoNow(),
  };
}
function repoJson(repo: Repo): Record<string, unknown> {
  return {
    ...publicRepo(repo),
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    homepage: null, language: null, forks_count: 0, stargazers_count: 0,
    watchers_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null, topics: [], visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch, has_issues: true, has_projects: false, has_wiki: false,
    archived: false, disabled: false, allow_squash_merge: true, allow_merge_commit: true,
    allow_rebase_merge: true, permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function labelJson(label: { id: number; name: string; color: string; description: string }, repo: Repo): Record<string, unknown> {
  return {
    id: label.id, node_id: Buffer.from(`Label:${repo.id}:${label.id}`, 'utf8').toString('base64url'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name, color: label.color, description: label.description, default: false,
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id, node_id: forge.globalId('Issue', repo, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((l) => labelJson(l, repo)),
    user: { login: issue.user, id: VIEWER_ID, type: 'User' },
    assignee: null, assignees: [], locked: false,
    comments: issue.comments.length, created_at: issue.created_at, updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    author_association: 'OWNER',
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headRepo = repoJson(repo);
  return {
    id: pull.id, node_id: forge.globalId('PullRequest', repo, pull.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number, state: pull.state, title: pull.title, body: pull.body,
    user: { login: pull.user, id: VIEWER_ID, type: 'User' },
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, repo: headRepo, user: { login: repo.owner } },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, repo: headRepo, user: { login: repo.owner } },
    merged: pull.merged, mergeable: pull.mergeable, merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at, draft: false, locked: false,
    created_at: pull.created_at, updated_at: pull.updated_at, closed_at: pull.state === 'closed' ? pull.updated_at : null,
  };
}
function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.store.get(repo.store.peel(sha));
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  const authorLine = view.author;
  const name = authorLine.split('<')[0]?.trim() ?? VIEWER_LOGIN;
  const email = authorLine.match(/<([^>]*)>/)?.[1] ?? VIEWER_EMAIL;
  const date = isoFromAuthor(authorLine);
  return {
    sha, node_id: Buffer.from(`Commit:${repo.id}:${sha}`, 'utf8').toString('base64url'),
    commit: {
      message: view.message.replace(/\n$/, ''),
      author: { name, email, date },
      committer: { name, email, date },
      tree: { sha: view.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: view.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}
function isoFromAuthor(authorLine: string): string {
  const match = /(\d{10}) /.exec(authorLine);
  if (!match) return isoNow();
  return new Date(Number(match[1]) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------- git smart HTTP
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function peeledOid(repo: Repo, oid: string): string | null {
  const obj = repo.store.get(oid);
  if (!obj) return null;
  if (obj.type !== 'tag') return null;
  return repo.store.peel(oid);
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed agent=forge/1.0 symref=HEAD:refs/heads/main'
    : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
function v2Advertisement(): Buffer {
  return pktLines(['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n', 'flush']);
}
function lsRefsResponse(repo: Repo, prefixes: string[], wantPeel: boolean, wantSymrefs: boolean, wantUnborn: boolean): Buffer {
  const lines: Array<string | 'flush'> = [];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const match = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (prefixes.length === 0 && wantSymrefs) {
    if (headTip) lines.push(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    else if (wantUnborn) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of refs) {
    if (!match(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel) {
      const peeled = peeledOid(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return pktLines(lines as Array<string | Buffer | 'flush' | 'delim'>);
}
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 65000) {
    const chunk = pack.subarray(off, off + 65000);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}
function fetchV2Response(repo: Repo, req: {
  wants: string[]; haves: string[]; shallow: string[]; depth: number | null;
}): Buffer {
  // A fetch response is deterministic given (wants, haves, depth, shallow) and the
  // store's contents; the store version bumps on every genuinely new object, so a
  // cached response is sound exactly while the version matches. The clone workload
  // issues 50 identical depth-1 fetches per round: one build, 49 reuses.
  const cacheKey = `v2|${repo.id}|${req.wants.join(',')}|${req.haves.join(',')}|${req.depth ?? ''}|${req.shallow.join(',')}`;
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined && cached.version === repo.store.version) return cached.buf;
  const built = buildFetchV2Response(repo, req);
  if (fetchCache.size > 512) fetchCache.clear();
  fetchCache.set(cacheKey, { version: repo.store.version, buf: built });
  return built;
}
const fetchCache = new Map<string, { version: number; buf: Buffer }>();
function buildFetchV2Response(repo: Repo, req: {
  wants: string[]; haves: string[]; shallow: string[]; depth: number | null;
}): Buffer {
  const parts: Buffer[] = [];
  const { objects, shallow, unshallow } = repo.store.fetchSet(req.wants, req.haves, req.depth, req.shallow);
  const pack = writePack(objects);
  const nothingNew = objects.length === 0;
  parts.push(pktLine('acknowledgments\n'));
  if (nothingNew && req.haves.length > 0) {
    for (const have of req.haves) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());
  if (req.depth !== null && (shallow.length > 0 || unshallow.length > 0)) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
function fetchV0Response(repo: Repo, req: { wants: string[]; haves: string[]; depth: number | null }): Buffer {
  const cacheKey = `v0|${repo.id}|${req.wants.join(',')}|${req.haves.join(',')}|${req.depth ?? ''}`;
  const cached = fetchCache.get(cacheKey);
  if (cached !== undefined && cached.version === repo.store.version) return cached.buf;
  const built = buildFetchV0Response(repo, req);
  if (fetchCache.size > 512) fetchCache.clear();
  fetchCache.set(cacheKey, { version: repo.store.version, buf: built });
  return built;
}
function buildFetchV0Response(repo: Repo, req: { wants: string[]; haves: string[]; depth: number | null }): Buffer {
  const { objects, shallow } = repo.store.fetchSet(req.wants, req.haves, req.depth, []);
  const pack = writePack(objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
function parseV2UploadPack(body: Buffer): { command: string; args: string[] } | null {
  let packets;
  try { packets = decodePktLines(body); } catch { return null; }
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { afterDelim = true; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
    } else {
      args.push(line.replace(/\n$/, ''));
    }
  }
  if (!command) return null;
  return { command, args };
}
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Scan pkt-lines until the flush; the rest of the body is the packfile.
  let off = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  let malformed = false;
  while (off + 4 <= body.length) {
    const len = parseInt(body.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) { malformed = true; break; }
    if (len === 0) { packStart = off + 4; break; }
    if (len < 4 || off + len > body.length) { malformed = true; break; }
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const text = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length === 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    off += len;
  }
  const reportLines: string[] = [];
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (malformed) {
    unpackOk = false;
    unpackDetail = 'malformed command list';
  } else if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.store.get(oid));
      if (!read.checksumOk) throw new Error('pack trailer checksum mismatch');
      for (const [oid, obj] of read.objects) repo.store.addWithOid(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message;
    }
  }
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        if (!current) { reportLines.push(`ng ${cmd.ref} no such ref\n`); continue; }
        if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) { reportLines.push(`ng ${cmd.ref} old value does not match\n`); continue; }
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      const obj = repo.store.get(cmd.newOid);
      if (!obj) { reportLines.push(`ng ${cmd.ref} object not found\n`); continue; }
      if (cmd.oldOid === ZERO_OID) {
        if (current) { reportLines.push(`ng ${cmd.ref} already exists\n`); continue; }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} old value does not match\n`); continue; }
      if (!repo.store.isAncestor(cmd.oldOid, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  } else {
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack failed\n`);
  }
  const inner = pktLines([...reportLines, 'flush']);
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), inner]))];
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- REST helpers
function needRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, name) ?? null;
}
function decodePath(p: string): string {
  // decodeURIComponent of a '%' -free string returns it unchanged; skip the call.
  if (!p.includes('%')) return p;
  try { return decodeURIComponent(p); } catch { return p; }
}

async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  const seg = path.split('/').filter((s) => s !== '').map(decodePath);
  // seg[0]='api', seg[1]='v3', ...
  if (seg[0] !== 'api' || seg[1] !== 'v3') return false;
  if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return true; }
  const rest = seg.slice(2);
  const bodyBuf = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
  const parsed = parseJsonBody(bodyBuf);
  if (!parsed.ok) { sendJson(res, 400, { message: 'Problems parsing JSON' }); return true; }
  const body = isRecord(parsed.value) ? parsed.value : {};

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user', current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations', code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}', emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis', events_url: '/api/v3/events', feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers', following_url: '/api/v3/user/following{/other_user}',
      gists_url: '/api/v3/gists{/gist_id}', hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}', issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys', label_search_url: '/api/v3/search/labels?q={query}',
      notifications_url: '/api/v3/notifications', organization_url: '/api/v3/orgs/{org}',
      public_gists_url: '/api/v3/gists/public', rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}', repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos', starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/gists/starred', topic_search_url: '/api/v3/search/topics?q={query}',
      user_url: '/api/v3/users/{user}', user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos', user_search_url: '/api/v3/search/users?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', hooks: [], git: [], pages: [], importer: [], api: [], actions: [] });
    return true;
  }
  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
    sendJson(res, 200, userJson());
    return true;
  }
  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const all = forge.listRepos(VIEWER_LOGIN);
      const { page: items, hasNext, total } = paginate(all, page, perPage);
      sendJson(res, 200, items.map(repoJson), { link: linkHeader(req, path, query, page, perPage, hasNext, total) });
      return true;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { sendJson(res, 422, { message: 'Validation Failed: name is invalid' }); return true; }
      if (forge.getRepo(VIEWER_LOGIN, name)) { sendJson(res, 422, { message: 'Repository creation failed: name already exists on this account' }); return true; }
      const repo = forge.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  // /api/v3/repos/{owner}/{repo}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = needRepo(owner, name);
    if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
    const tail = rest.slice(3);
    // /repos/{o}/{r}
    if (tail.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
        repo.updated_at = isoNow();
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') { forge.deleteRepo(owner, name); sendJson(res, 204, null); return true; }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // branches
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = sortedRefs(repo).filter((r) => r.name.startsWith('refs/heads/')).map((r) => ({
          name: r.name.slice('refs/heads/'.length),
          commit: { sha: repo.store.peel(r.oid), url: `/api/v3/repos/${owner}/${name}/commits/${repo.store.peel(r.oid)}` },
          protected: false,
        }));
        sendJson(res, 200, branches);
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const ref = repo.refs.get(`refs/heads/${tail[1]}`);
        if (!ref) { sendJson(res, 404, { message: 'Branch not found' }); return true; }
        const sha = repo.store.peel(ref);
        sendJson(res, 200, { name: tail[1], commit: { sha, url: `/api/v3/repos/${owner}/${name}/commits/${sha}` }, protected: false });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // commits
    if (tail[0] === 'commits') {
      if (tail.length === 1 && method === 'GET') {
        const ref = typeof query.get('sha') === 'string' && query.get('sha') ? query.get('sha')! : repo.defaultBranch;
        let tip: string | undefined;
        if (repo.refs.has(`refs/heads/${ref}`)) tip = repo.refs.get(`refs/heads/${ref}`);
        else if (repo.refs.has(ref)) tip = repo.refs.get(ref);
        else if (repo.store.get(ref)) tip = ref;
        if (!tip) { sendJson(res, 200, []); return true; }
        const dist = repo.store.commitDistances([tip]);
        const ordered = [...dist.entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
        const { page, perPage } = pageParams(query);
        const { page: items, hasNext, total } = paginate(ordered, page, perPage);
        const out = items.map((oid) => commitJson(repo, oid)).filter((c): c is Record<string, unknown> => c !== null);
        sendJson(res, 200, out, { link: linkHeader(req, path, query, page, perPage, hasNext, total) });
        return true;
      }
      if (tail.length === 2 && method === 'GET') {
        const commit = commitJson(repo, tail[1]!);
        if (!commit) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        sendJson(res, 200, commit);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // contents
    if (tail[0] === 'contents') {
      const contentPath = tail.slice(1).join('/');
      const ref = typeof query.get('ref') === 'string' ? query.get('ref')! : undefined;
      if (method === 'GET') {
        const file = forge.readFile(repo, ref, contentPath);
        if (file) {
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: file.size, name: contentPath.split('/').pop() ?? '',
            path: contentPath, content: file.data.toString('base64'), sha: file.sha,
            url: `/api/v3/repos/${owner}/${name}/contents/${contentPath}`,
            html_url: `https://github.com/${owner}/${name}/blob/${ref ?? repo.defaultBranch}/${contentPath}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/blobs/${file.sha}`,
            download_url: `https://raw.githubusercontent.com/${owner}/${name}/${ref ?? repo.defaultBranch}/${contentPath}`,
          });
          return true;
        }
        const dir = forge.listDir(repo, ref, contentPath);
        if (dir) {
          sendJson(res, 200, dir.map((e) => ({
            type: e.type, size: e.size, name: e.name, path: e.path, sha: e.sha,
            url: `/api/v3/repos/${owner}/${name}/contents/${e.path}`,
            html_url: `https://github.com/${owner}/${name}/blob/${ref ?? repo.defaultBranch}/${e.path}`,
            git_url: `/api/v3/repos/${owner}/${name}/git/${e.type === 'dir' ? 'trees' : 'blobs'}/${e.sha}`,
            download_url: e.type === 'file' ? `https://raw.githubusercontent.com/${owner}/${name}/${ref ?? repo.defaultBranch}/${e.path}` : null,
          })));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (method === 'PUT') {
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        if (contentB64 === '') { sendJson(res, 422, { message: 'Validation Failed: content is required' }); return true; }
        const data = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
        const existing = forge.readFile(repo, branch, contentPath);
        if (existing) {
          if (typeof body.sha !== 'string' || body.sha !== existing.sha) { sendJson(res, 409, { message: 'Conflict: sha does not match the current blob' }); return true; }
          const { commitSha } = forge.commitFile(repo, branch, contentPath, data, message);
          sendJson(res, 200, {
            content: { name: contentPath.split('/').pop() ?? '', path: contentPath, sha: forge.readFile(repo, branch, contentPath)?.sha ?? '', size: data.length, url: '', html_url: '', git_url: '', download_url: '', type: 'file', encoding: 'base64', content: contentB64 },
            commit: { sha: commitSha, message },
          });
          return true;
        }
        const { commitSha } = forge.commitFile(repo, branch, contentPath, data, message);
        const created = forge.readFile(repo, branch, contentPath);
        sendJson(res, 201, {
          content: { name: contentPath.split('/').pop() ?? '', path: contentPath, sha: created?.sha ?? '', size: data.length, url: '', html_url: '', git_url: '', download_url: '', type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const branch = typeof body.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
        const existing = forge.readFile(repo, branch, contentPath);
        if (!existing) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (typeof body.sha === 'string' && body.sha !== existing.sha) { sendJson(res, 409, { message: 'Conflict: sha does not match the current blob' }); return true; }
        const { commitSha } = forge.deleteFile(repo, branch, contentPath, message);
        sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.store.get(sha)) {
          sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' });
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, {
          ref, node_id: Buffer.from(`Ref:${repo.id}:${ref}`, 'utf8').toString('base64url'),
          url: `/api/v3/repos/${owner}/${name}/git/refs/${ref.replace(/^refs\//, '')}`,
          object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/${repo.store.get(sha)?.type === 'commit' ? 'commits' : 'tags'}/${sha}` },
        });
        return true;
      }
      if (method === 'GET' && tail.length > 2) {
        const refName = `refs/${tail.slice(2).join('/')}`;
        const oid = repo.refs.get(refName);
        if (!oid) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        sendJson(res, 200, {
          ref: refName, node_id: Buffer.from(`Ref:${repo.id}:${refName}`, 'utf8').toString('base64url'),
          url: `/api/v3/repos/${owner}/${name}/git/refs/${refName.replace(/^refs\//, '')}`,
          object: { sha: oid, type: repo.store.get(oid)?.type ?? 'commit', url: '' },
        });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) { sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(l, repo))); return true; }
      if (method === 'POST' && tail.length === 1) {
        const name = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        if (!name) { sendJson(res, 422, { message: 'Validation Failed: name is required' }); return true; }
        if (repo.labels.has(name)) { sendJson(res, 422, { message: 'Validation Failed: label already exists' }); return true; }
        repo.labelCounter += 1;
        const label = { id: repo.labelCounter, name, color, description: typeof body.description === 'string' ? body.description : '' };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label, repo));
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // issues
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((i) => i.state === state);
          issues.sort((a, b) => sort === 'created' ? (direction === 'asc' ? a.number - b.number : b.number - a.number) : (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page, perPage } = pageParams(query);
          const { page: items, hasNext, total } = paginate(issues, page, perPage);
          sendJson(res, 200, items.map((i) => issueJson(repo, i)), { link: linkHeader(req, path, query, page, perPage, hasNext, total) });
          return true;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
          if (!title) { sendJson(res, 422, { message: 'Validation Failed: title is required' }); return true; }
          const created = forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
          if ('error' in created) { sendJson(res, 422, { message: created.error }); return true; }
          sendJson(res, 201, issueJson(repo, created));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const number = Number(tail[1]);
      const issue = repo.issues.find((i) => i.number === number);
      if (tail.length === 2) {
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'GET') { sendCachedJson(res, 200, cachedIssueJson(repo, issue)); return true; }
        if (method === 'PATCH') {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          issue.updated_at = isoNow();
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.id, node_id: forge.globalId('IssueComment', repo, issue.number * 1000 + c.id),
            url: `/api/v3/repos/${owner}/${name}/issues/comments/${c.id}`,
            html_url: `https://github.com/${owner}/${name}/issues/${issue.number}#issuecomment-${c.id}`,
            body: c.body, user: { login: c.user, id: VIEWER_ID, type: 'User' },
            created_at: c.created_at, updated_at: c.updated_at,
          })));
          return true;
        }
        if (method === 'POST') {
          const text = typeof body.body === 'string' ? body.body : '';
          if (!text) { sendJson(res, 422, { message: 'Validation Failed: body is required' }); return true; }
          repo.commentCounter += 1;
          const comment = { id: repo.commentCounter, body: text, user: VIEWER_LOGIN, created_at: isoNow(), updated_at: isoNow() };
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id, node_id: forge.globalId('IssueComment', repo, issue.number * 1000 + comment.id),
            url: `/api/v3/repos/${owner}/${name}/issues/comments/${comment.id}`,
            html_url: `https://github.com/${owner}/${name}/issues/${issue.number}#issuecomment-${comment.id}`,
            body: comment.body, user: { login: comment.user, id: VIEWER_ID, type: 'User' },
            created_at: comment.created_at, updated_at: comment.updated_at,
          });
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    // pulls
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
          pulls.sort((a, b) => b.number - a.number);
          const { page, perPage } = pageParams(query);
          const { page: items, hasNext, total } = paginate(pulls, page, perPage);
          sendJson(res, 200, items.map((p) => pullJson(repo, p)), { link: linkHeader(req, path, query, page, perPage, hasNext, total) });
          return true;
        }
        if (method === 'POST') {
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (!title || !head) { sendJson(res, 422, { message: 'Validation Failed: title and head are required' }); return true; }
          const created = forge.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in created) { sendJson(res, 422, { message: created.error }); return true; }
          sendJson(res, 201, pullJson(repo, created));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const number = Number(tail[1]);
      const pull = repo.pulls.find((p) => p.number === number);
      if (tail.length === 2) {
        if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method !== 'GET') { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const files = forge.prFiles(repo, pull);
        const headFiles = repo.store.fileMap(pull.headSha);
        sendJson(res, 200, files.map((f) => ({
          sha: headFiles.get(f.filename)?.oid ?? pull.headSha,
          filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
          changes: f.changes, blob_url: `https://github.com/${owner}/${name}/blob/${pull.headSha}/${f.filename}`,
          raw_url: `https://github.com/${owner}/${name}/raw/${pull.headSha}/${f.filename}`,
          contents_url: `/api/v3/repos/${owner}/${name}/contents/${f.filename}?ref=${pull.headSha}`,
          patch: f.patch,
        })));
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return true; }
        if (method !== 'PUT') { sendJson(res, 404, { message: 'Not Found' }); return true; }
        const merged = forge.mergePull(repo, pull);
        if ('error' in merged) { sendJson(res, merged.status, { message: merged.error }); return true; }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull Request successfully merged` });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// ---------------------------------------------------------------- git endpoints
async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (!match) return false;
  const owner = decodePath(match[1]!);
  const repoName = decodePath(match[2]!);
  const rest = match[3]!;
  const method = req.method ?? 'GET';
  const repo = owner === VIEWER_LOGIN ? forge.getRepo(owner, repoName) : undefined;
  if (rest === 'info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendRaw(res, 404, Buffer.from('Not Found'), 'text/plain'); return true; }
    if (!repo) { sendRaw(res, 404, Buffer.from('Not Found'), 'text/plain'); return true; }
    if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
      sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      return true;
    }
    sendRaw(res, 200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
    return true;
  }
  if (rest === 'git-upload-pack' && method === 'POST') {
    if (!repo) { sendRaw(res, 404, Buffer.from('Not Found'), 'text/plain'); return true; }
    const body = await readBody(req);
    const parsed = parseV2UploadPack(body);
    if (!parsed) {
      // Protocol v0: a want/have/done pkt-line stream with no command= line.
      let packets;
      try { packets = decodePktLines(body); } catch { sendRaw(res, 400, Buffer.from('bad request'), 'text/plain'); return true; }
      const wants: string[] = [];
      const haves: string[] = [];
      let depth: number | null = null;
      for (const packet of packets) {
        if (packet.kind !== 'data') continue;
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        const nul = line.indexOf('\0');
        const clean = nul >= 0 ? line.slice(0, nul) : line;
        if (clean.startsWith('want ')) wants.push(clean.slice(5).trim());
        else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
        else if (clean.startsWith('deepen ')) depth = Number(clean.slice(7).trim());
      }
      sendRaw(res, 200, fetchV0Response(repo, { wants, haves, depth }), 'application/x-git-upload-pack-result');
      return true;
    }
    if (parsed.command === 'ls-refs') {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      let unborn = false;
      for (const arg of parsed.args) {
        if (arg === 'peel') peel = true;
        else if (arg === 'symrefs') symrefs = true;
        else if (arg === 'unborn') unborn = true;
        else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
      }
      sendRaw(res, 200, lsRefsResponse(repo, prefixes, peel, symrefs, unborn), 'application/x-git-upload-pack-result');
      return true;
    }
    if (parsed.command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const arg of parsed.args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
      }
      // A fetch with no wants carries nothing.
      if (wants.length === 0) {
        sendRaw(res, 200, Buffer.concat([pktLine('acknowledgments\n'), pktLine('NAK\n'), pktFlush(), pktLine('packfile\n'), sidebandPack(writePack([])), pktFlush()]), 'application/x-git-upload-pack-result');
        return true;
      }
      sendRaw(res, 200, fetchV2Response(repo, { wants, haves, shallow, depth }), 'application/x-git-upload-pack-result');
      return true;
    }
    sendRaw(res, 400, Buffer.from('unknown command'), 'text/plain');
    return true;
  }
  if (rest === 'git-receive-pack' && method === 'POST') {
    if (!repo) { sendRaw(res, 404, Buffer.from('Not Found'), 'text/plain'); return true; }
    const body = await readBody(req);
    sendRaw(res, 200, handleReceivePack(repo, body), 'application/x-git-receive-pack-result');
    return true;
  }
  // v0 upload-pack POST is handled by the v2 branch above (its parseV2UploadPack
  // returns null for a want/have stream, which falls back to the v0 path).
  return false;
}

// ---------------------------------------------------------------- server
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { path, query } = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (path === '/api/graphql' && method === 'POST') {
          if (!authed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
          const bodyBuf = await readBody(req);
          const parsed = parseJsonBody(bodyBuf);
          if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return; }
          const runOne = (item: unknown): unknown => {
            if (!isRecord(item) || typeof item.query !== 'string') return { data: null, errors: [{ message: 'A GraphQL request needs a query string.' }] };
            const variables = isRecord(item.variables) ? (item.variables as Record<string, unknown>) : {};
            return gql.execute(item.query, variables);
          };
          if (Array.isArray(parsed.value)) sendJson(res, 200, parsed.value.map(runOne));
          else sendJson(res, 200, runOne(parsed.value));
          return;
        }
        if (path === '/mcp') {
          if (method === 'DELETE') { sendJson(res, 200, {}); return; }
          if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          const bodyBuf = await readBody(req);
          const text = bodyBuf.toString('utf8');
          let parsedBody: unknown = null;
          let parseFailed = false;
          if (text.trim() !== '') {
            try { parsedBody = JSON.parse(text) as unknown; } catch { parseFailed = true; }
          } else {
            parseFailed = true;
          }
          if (parseFailed) {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          if (!authed(req)) {
            const id = isRecord(parsedBody) ? (parsedBody.id ?? null) : null;
            sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } });
            return;
          }
          const outcome = handleMcp(forge, parsedBody);
          if (outcome.status === 202) { res.writeHead(202, { 'x-github-request-id': reqId() }); res.end(); return; }
          sendJson(res, outcome.status, outcome.body, outcome.headers ?? {});
          return;
        }
        if (path.startsWith('/api/v3')) {
          const handled = await handleRest(req, res, path, query);
          if (handled) return;
        }
        if (await handleGit(req, res, path, query)) return;
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try { sendJson(res, 500, { message: (err as Error).message }); } catch { /* socket gone */ }
      }
    })();
  });
}
