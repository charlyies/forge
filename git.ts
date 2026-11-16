// git.ts — pure-Node git object store, packfile read/write, pkt-line framing.
// No git binary, no dependencies: node:crypto and node:zlib only.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjType; data: Buffer }
export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- pkt-lines
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}
export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';
export interface Pkt { kind: PktKind; payload: Buffer }
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

// ---------------------------------------------------------------- packfiles
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}
function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++]!;
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++]! * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackRead { objects: Map<string, GitObject>; deltaCount: number; checksumOk: boolean }
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  interface RawEntry {
    offset: number; typeCode: number; size: number; data: Buffer;
    baseOffset?: number; baseOid?: string; resolvedType?: ObjType; resolved?: Buffer; oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount, checksumOk };
}

// ---------------------------------------------------------------- object graph
export interface TreeEntry { mode: string; name: string; oid: string }
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
export function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** The object store of one repository (in-memory). Objects are immutable, so parsed
 *  views are cached forever; `version` bumps only when a genuinely new object lands. */
export class ObjStore {
  objects = new Map<string, GitObject>();
  version = 0;
  private commitCache = new Map<string, CommitView>();
  private treeCache = new Map<string, TreeEntry[]>();
  get(oid: string): GitObject | undefined { return this.objects.get(oid); }
  has(oid: string): boolean { return this.objects.has(oid); }
  put(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) { this.objects.set(oid, { type, data }); this.version += 1; }
    return oid;
  }
  add(obj: GitObject): string {
    const oid = hashObject(obj.type, obj.data);
    if (!this.objects.has(oid)) { this.objects.set(oid, obj); this.version += 1; }
    return oid;
  }
  /** Store an object whose oid is already known (e.g. from readPack): skips re-hashing. */
  addWithOid(oid: string, obj: GitObject): void {
    if (!this.objects.has(oid)) { this.objects.set(oid, obj); this.version += 1; }
  }
  /** Parsed commit view, cached: objects never change, so the cache is always sound. */
  commitView(oid: string): CommitView | null {
    let view = this.commitCache.get(oid);
    if (view !== undefined) return view;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    view = parseCommit(obj.data);
    this.commitCache.set(oid, view);
    return view;
  }
  /** Parsed tree entries, cached: objects never change, so the cache is always sound. */
  treeEntries(oid: string): TreeEntry[] | null {
    let entries = this.treeCache.get(oid);
    if (entries !== undefined) return entries;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return null;
    entries = parseTree(obj.data);
    this.treeCache.set(oid, entries);
    return entries;
  }
  /** Peel a tag (possibly nested) to its commit. */
  peel(oid: string): string {
    let cur = oid;
    for (let i = 0; i < 16; i += 1) {
      const obj = this.objects.get(cur);
      if (!obj || obj.type !== 'tag') return cur;
      cur = parseTag(obj.data).object;
    }
    return cur;
  }
  /** Commit distance (BFS generations) from any of `tips`, following parents. */
  commitDistances(tips: Iterable<string>): Map<string, number> {
    const dist = new Map<string, number>();
    const queue: string[] = [];
    for (const tip of tips) {
      const peeled = this.peel(tip);
      if (this.objects.get(peeled)?.type === 'commit' && !dist.has(peeled)) {
        dist.set(peeled, 0);
        queue.push(peeled);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++]!;
      const d = dist.get(oid)!;
      const view = this.commitView(oid);
      if (view === null) continue;
      for (const parent of view.parents) {
        if (!dist.has(parent) && this.objects.get(parent)?.type === 'commit') {
          dist.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }
    return dist;
  }
  /** All commit oids reachable from `tips` (parents only). */
  reachableCommits(tips: Iterable<string>): Set<string> {
    return new Set(this.commitDistances(tips).keys());
  }
  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>([descendant]);
    const queue = [descendant];
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++]!;
      const view = this.commitView(this.peel(oid));
      if (view === null) continue;
      for (const parent of view.parents) {
        if (parent === ancestor) return true;
        if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
      }
    }
    return false;
  }
  /** A common ancestor of a and b, preferring the one closest to both (min max distance). */
  mergeBase(a: string, b: string): string | null {
    const da = this.commitDistances([a]);
    const db = this.commitDistances([b]);
    let best: string | null = null;
    let bestScore = Infinity;
    for (const [oid, d1] of da) {
      const d2 = db.get(oid);
      if (d2 === undefined) continue;
      const score = Math.max(d1, d2);
      if (score < bestScore) { bestScore = score; best = oid; }
    }
    return best;
  }
  /** Full file map (path -> {mode, oid}) of a commit's tree, recursively. */
  fileMap(commitOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const view = this.commitView(this.peel(commitOid));
    if (view === null) return out;
    const walk = (treeOid: string, prefix: string): void => {
      const entries = this.treeEntries(treeOid);
      if (entries === null) return;
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(view.tree, '');
    return out;
  }
  /** Commits the client already holds: ancestors of `haves`, not crossing a prior
   *  shallow boundary (a shallow clone holds the boundary commit, not its parents). */
  haveClosure(haves: Iterable<string>, priorShallow: Iterable<string>): { commits: Set<string>; objects: Set<string> } {
    const boundary = new Set([...priorShallow].map((oid) => this.peel(oid)));
    const commits = new Set<string>();
    const objects = new Set<string>();
    const queue: string[] = [];
    for (const tip of haves) {
      const peeled = this.peel(tip);
      if (this.objects.get(peeled)?.type === 'commit' && !commits.has(peeled)) {
        commits.add(peeled);
        queue.push(peeled);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++]!;
      objects.add(oid);
      const view = this.commitView(oid);
      if (view === null) continue;
      const addTree = (treeOid: string): void => {
        if (objects.has(treeOid)) return;
        objects.add(treeOid);
        const entries = this.treeEntries(treeOid);
        if (entries === null) return;
        for (const entry of entries) {
          if (entry.mode === '40000') addTree(entry.oid);
          else objects.add(entry.oid);
        }
      };
      addTree(view.tree);
      if (boundary.has(oid)) continue;
      for (const parent of view.parents) {
        if (!commits.has(parent) && this.objects.get(parent)?.type === 'commit') {
          commits.add(parent);
          queue.push(parent);
        }
      }
    }
    return { commits, objects };
  }
  /** The object set for a fetch: commits at distance < depth from wants (or all), minus have-reachable. */
  fetchSet(wants: string[], haves: string[], depth: number | null, priorShallow: string[]): {
    objects: GitObject[]; shallow: string[]; unshallow: string[];
  } {
    const have = this.haveClosure(haves, priorShallow);
    const haveCommits = have.commits;
    const haveObjects = have.objects;
    const dist = this.commitDistances(wants);
    const included = new Set<string>();
    const shallow: string[] = [];
    for (const [oid, d] of dist) {
      if (haveCommits.has(oid)) continue;
      if (depth !== null && d >= depth) continue;
      included.add(oid);
      if (depth !== null && d === depth - 1) shallow.push(oid);
    }
    const unshallow: string[] = [];
    if (depth !== null) {
      for (const oid of priorShallow) {
        const d = dist.get(this.peel(oid));
        if (d !== undefined && d < depth) unshallow.push(oid);
      }
    }
    // Include tag objects named directly as wants, plus their targets.
    const tagObjects = new Set<string>();
    for (const want of wants) {
      const obj = this.objects.get(want);
      if (obj?.type === 'tag') tagObjects.add(want);
    }
    const objects = new Map<string, GitObject>();
    const addObj = (oid: string): void => {
      if (haveObjects.has(oid)) return;
      const obj = this.objects.get(oid);
      if (obj && !objects.has(oid)) objects.set(oid, obj);
    };
    const addTree = (treeOid: string): void => {
      if (haveObjects.has(treeOid)) return;
      const entries = this.treeEntries(treeOid);
      if (entries === null) return;
      addObj(treeOid);
      for (const entry of entries) {
        if (entry.mode === '40000') addTree(entry.oid);
        else addObj(entry.oid);
      }
    };
    for (const oid of tagObjects) addObj(oid);
    for (const oid of included) {
      addObj(oid);
      const view = this.commitView(oid);
      if (view !== null) addTree(view.tree);
    }
    return { objects: [...objects.values()], shallow, unshallow };
  }
}
