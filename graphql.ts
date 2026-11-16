// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send (see the kit's checks-graphql.ts): viewer, repository,
// node, __type, issues/pullRequests connections, and the five mutations.
import { isoNow, VIEWER_LOGIN, type Forge, type Issue, type Pull, type Repo } from './store.ts';

export interface GqlIssue { id: string; number: number; title: string; body: string; state: string }
export interface GqlPull { id: string; number: number; title: string; state: string; headRefName: string; baseRefName: string; mergeable: boolean; merged: boolean }

// ---------------------------------------------------------------- parser
interface FieldNode {
  alias: string; name: string;
  args: Record<string, unknown>;
  children: FieldNode[];
  fragmentType?: string;
}
interface Operation { kind: 'query' | 'mutation'; name: string | null; fields: FieldNode[] }

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch) || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if ('{}():![]=@$'.includes(ch) || ch === '.') {
      if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
      tokens.push(ch); i += 1; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; } else { out += src[j]; j += 1; }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_-]/.test(src[j]!)) j += 1;
    if (j === i) { i += 1; continue; }
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  pos = 0;
  private tokens: string[];
  private variables: Record<string, unknown>;
  constructor(tokens: string[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }
  peek(): string { return this.tokens[this.pos] ?? ''; }
  next(): string { return this.tokens[this.pos++] ?? ''; }
  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }
  parseValue(): unknown {
    const tok = this.next();
    if (tok === '$') return this.variables[this.next()] ?? null;
    if (tok === '[') {
      const arr: unknown[] = [];
      while (this.peek() !== ']') arr.push(this.parseValue());
      this.expect(']');
      return arr;
    }
    if (tok === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (tok.startsWith('"')) return JSON.parse(tok) as unknown;
    const num = Number(tok);
    if (tok !== '' && !Number.isNaN(num)) return num;
    return tok;
  }
  parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseSelection(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeName = this.next();
          const children = this.parseSelection();
          for (const child of children) fields.push({ ...child, fragmentType: typeName });
        } else {
          // Named fragment spread: not used by the suite's documents; skip its selection.
          this.next();
        }
        continue;
      }
      let name = this.next();
      let alias = name;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      let args: Record<string, unknown> = {};
      if (this.peek() === '(') args = this.parseArgs();
      let children: FieldNode[] = [];
      if (this.peek() === '{') children = this.parseSelection();
      fields.push({ alias, name, args, children });
    }
    this.expect('}');
    return fields;
  }
  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    if (this.peek() === 'query' || this.peek() === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      if (this.peek() !== '{' && this.peek() !== '(') name = this.next();
      if (this.peek() === '(') {
        // Variable definitions: skip the balanced parens.
        let depth = 0;
        do {
          const tok = this.next();
          if (tok === '(') depth += 1;
          else if (tok === ')') depth -= 1;
        } while (depth > 0 && this.pos < this.tokens.length);
      }
    }
    const fields = this.parseSelection();
    return { kind, name, fields };
  }
}

function parseDocument(query: string, variables: Record<string, unknown>): Operation {
  const parser = new Parser(tokenize(query), variables);
  return parser.parseOperation();
}

// ---------------------------------------------------------------- schema knowledge
const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url'];
const PULL_FIELDS = ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'author'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'createdAt', 'updatedAt', 'url'];
const VIEWER_FIELDS = ['login', 'id', 'name'];
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'WIKI', 'PACKAGE'];

function unknownFieldError(field: string, parentType: string): { message: string } {
  return { message: `Cannot query field "${field}" on type "${parentType}".` };
}

// ---------------------------------------------------------------- executor
export class GraphQLExecutor {
  private forge: Forge;
  constructor(forge: Forge) { this.forge = forge; }

  execute(query: string, variables: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
    let op: Operation;
    try {
      op = parseDocument(query, variables);
    } catch (err) {
      return { data: null, errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
    }
    if (op.kind === 'mutation') return this.runMutation(op.fields);
    const data: Record<string, unknown> = {};
    const errors: Array<{ message: string }> = [];
    for (const field of op.fields) {
      const value = this.resolveQueryField(field, errors);
      data[field.alias] = value;
    }
    return errors.length ? { data, errors } : { data };
  }

  private resolveQueryField(field: FieldNode, errors: Array<{ message: string }>): unknown {
    if (field.name === 'viewer') {
      if (field.children.length === 0) return { login: VIEWER_LOGIN };
      const out: Record<string, unknown> = {};
      for (const child of field.children) {
        if (child.name === 'login') out[child.alias] = VIEWER_LOGIN;
        else if (child.name === 'id') out[child.alias] = Buffer.from(`User:${1000}`, 'utf8').toString('base64url');
        else if (child.name === 'name') out[child.alias] = 'ada iversen';
        else errors.push(unknownFieldError(child.name, 'Viewer'));
      }
      return out;
    }
    if (field.name === 'repository') {
      const owner = String(field.args.owner ?? '');
      const name = String(field.args.name ?? '');
      const repo = this.forge.getRepo(owner, name);
      if (!repo) return null;
      return this.resolveRepo(repo, field.children, errors);
    }
    if (field.name === 'node') {
      const id = String(field.args.id ?? '');
      const decoded = this.forge.decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = this.forge.findRepoById(decoded.repoId);
        if (!repo) return null;
        return this.resolveRepoFragment(repo, field.children, errors);
      }
      if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
        const repo = this.forge.findRepoById(decoded.repoId);
        if (!repo) return null;
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.find((x) => x.number === decoded.num);
          if (!issue) return null;
          return this.resolveIssue(repo, issue, field.children, errors);
        }
        const pull = repo.pulls.find((x) => x.number === decoded.num);
        if (!pull) return null;
        return this.resolvePull(repo, pull, field.children, errors);
      }
      return null;
    }
    if (field.name === '__type') {
      const typeName = String(field.args.name ?? '');
      return this.resolveType(field, typeName, errors);
    }
    errors.push(unknownFieldError(field.name, 'Query'));
    return null;
  }

  private resolveType(field: FieldNode, typeName: string, errors: Array<{ message: string }>): unknown {
    const fieldsByType: Record<string, string[]> = {
      Issue: ISSUE_FIELDS, PullRequest: PULL_FIELDS, Repository: REPO_FIELDS,
    };
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'fields') {
        const names = fieldsByType[typeName];
        out[child.alias] = names ? names.map((n) => ({ name: n })) : null;
      } else if (child.name === 'enumValues') {
        out[child.alias] = typeName === 'SearchType' ? SEARCH_ENUM.map((n) => ({ name: n })) : null;
      } else if (child.name === 'name') {
        out[child.alias] = typeName;
      } else if (child.name === 'kind') {
        out[child.alias] = typeName === 'SearchType' ? 'ENUM' : 'OBJECT';
      } else {
        errors.push(unknownFieldError(child.name, '__Type'));
      }
    }
    if (typeName !== 'Issue' && typeName !== 'PullRequest' && typeName !== 'Repository' && typeName !== 'SearchType') {
      return null;
    }
    return out;
  }

  private resolveRepoFragment(repo: Repo, children: FieldNode[], errors: Array<{ message: string }>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.fragmentType && child.fragmentType !== 'Repository') continue;
      if (child.name === 'id') out[child.alias] = this.forge.repoGlobalId(repo);
      else if (child.name === 'name') out[child.alias] = repo.name;
      else if (child.name === 'nameWithOwner') out[child.alias] = `${repo.owner}/${repo.name}`;
      else errors.push(unknownFieldError(child.name, 'Repository'));
    }
    return out;
  }

  private resolveRepo(repo: Repo, children: FieldNode[], errors: Array<{ message: string }>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.fragmentType && child.fragmentType !== 'Repository') continue;
      switch (child.name) {
        case 'id': out[child.alias] = this.forge.repoGlobalId(repo); break;
        case 'databaseId': out[child.alias] = repo.id; break;
        case 'name': out[child.alias] = repo.name; break;
        case 'nameWithOwner': out[child.alias] = `${repo.owner}/${repo.name}`; break;
        case 'description': out[child.alias] = repo.description; break;
        case 'createdAt': out[child.alias] = repo.created_at; break;
        case 'updatedAt': out[child.alias] = repo.updated_at; break;
        case 'url': out[child.alias] = `https://github.com/${repo.owner}/${repo.name}`; break;
        case 'owner': {
          const ownerOut: Record<string, unknown> = {};
          for (const sub of child.children) {
            if (sub.name === 'login') ownerOut[sub.alias] = repo.owner;
            else if (sub.name === 'id') ownerOut[sub.alias] = Buffer.from(`User:${1000}`, 'utf8').toString('base64url');
            else errors.push(unknownFieldError(sub.name, 'User'));
          }
          out[child.alias] = ownerOut;
          break;
        }
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) { out[child.alias] = null; break; }
          const refOut: Record<string, unknown> = {};
          for (const sub of child.children) {
            if (sub.name === 'name') refOut[sub.alias] = repo.defaultBranch;
            else if (sub.name === 'target') refOut[sub.alias] = { oid: repo.store.peel(tip) };
            else errors.push(unknownFieldError(sub.name, 'Ref'));
          }
          out[child.alias] = refOut;
          break;
        }
        case 'viewerPermission': out[child.alias] = 'ADMIN'; break;
        case 'hasIssuesEnabled': out[child.alias] = true; break;
        case 'issue': {
          const number = Number(child.args.number);
          const issue = repo.issues.find((x) => x.number === number);
          out[child.alias] = issue ? this.resolveIssue(repo, issue, child.children, errors) : null;
          break;
        }
        case 'issues': out[child.alias] = this.resolveIssueConnection(repo, child, errors); break;
        case 'pullRequest': {
          const number = Number(child.args.number);
          const pull = repo.pulls.find((x) => x.number === number);
          out[child.alias] = pull ? this.resolvePull(repo, pull, child.children, errors) : null;
          break;
        }
        case 'pullRequests': out[child.alias] = this.resolvePullConnection(repo, child, errors); break;
        default: errors.push(unknownFieldError(child.name, 'Repository'));
      }
    }
    return out;
  }

  private issueState(issue: Issue): string { return issue.state === 'open' ? 'OPEN' : 'CLOSED'; }
  private pullState(pull: Pull): string { return pull.state === 'open' ? 'OPEN' : 'CLOSED'; }

  private resolveIssue(repo: Repo, issue: Issue, children: FieldNode[], errors: Array<{ message: string }>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.fragmentType && child.fragmentType !== 'Issue') continue;
      switch (child.name) {
        case 'id': out[child.alias] = this.forge.globalId('Issue', repo, issue.number); break;
        case 'number': out[child.alias] = issue.number; break;
        case 'title': out[child.alias] = issue.title; break;
        case 'body': out[child.alias] = issue.body; break;
        case 'state': out[child.alias] = this.issueState(issue); break;
        case 'createdAt': out[child.alias] = issue.created_at; break;
        case 'updatedAt': out[child.alias] = issue.updated_at; break;
        case 'author': out[child.alias] = { login: issue.user }; break;
        case 'url': out[child.alias] = `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`; break;
        default: errors.push(unknownFieldError(child.name, 'Issue'));
      }
    }
    return out;
  }

  private resolvePull(repo: Repo, pull: Pull, children: FieldNode[], errors: Array<{ message: string }>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const child of children) {
      if (child.fragmentType && child.fragmentType !== 'PullRequest') continue;
      switch (child.name) {
        case 'id': out[child.alias] = this.forge.globalId('PullRequest', repo, pull.number); break;
        case 'number': out[child.alias] = pull.number; break;
        case 'title': out[child.alias] = pull.title; break;
        case 'body': out[child.alias] = pull.body; break;
        case 'state': out[child.alias] = this.pullState(pull); break;
        case 'headRefName': out[child.alias] = pull.headRef; break;
        case 'baseRefName': out[child.alias] = pull.baseRef; break;
        case 'mergeable': out[child.alias] = pull.mergeable ? 'MERGEABLE' : 'CONFLICTING'; break;
        case 'merged': out[child.alias] = pull.merged; break;
        case 'createdAt': out[child.alias] = pull.created_at; break;
        case 'updatedAt': out[child.alias] = pull.updated_at; break;
        case 'author': out[child.alias] = { login: pull.user }; break;
        case 'files': {
          const first = typeof child.args.first === 'number' ? child.args.first : 100;
          const files = this.forge.prFiles(repo, pull).slice(0, first);
          const nodes: Array<Record<string, unknown>> = [];
          for (const file of files) {
            const nodeOut: Record<string, unknown> = {};
            for (const sub of child.children) {
              if (sub.name === 'nodes') {
                // files connection: children are the connection fields; handled below.
              }
              void nodeOut;
              void sub;
            }
            void nodeOut;
            void files;
          }
          // Resolve the connection shape: nodes { path } and pageInfo.
          const conn: Record<string, unknown> = {};
          for (const sub of child.children) {
            if (sub.name === 'nodes') {
              conn[sub.alias] = files.map((file) => {
                const n: Record<string, unknown> = {};
                for (const f of sub.children) {
                  if (f.name === 'path') n[f.alias] = file.filename;
                  else if (f.name === 'additions') n[f.alias] = file.additions;
                  else if (f.name === 'deletions') n[f.alias] = file.deletions;
                  else if (f.name === 'changeType') n[f.alias] = file.status.toUpperCase();
                  else errors.push(unknownFieldError(f.name, 'PullRequestChangedFile'));
                }
                return n;
              });
            } else if (sub.name === 'pageInfo') {
              conn[sub.alias] = { hasNextPage: false, endCursor: null };
            } else if (sub.name === 'totalCount') {
              conn[sub.alias] = files.length;
            } else {
              errors.push(unknownFieldError(sub.name, 'PullRequestChangedFileConnection'));
            }
          }
          out[child.alias] = conn;
          break;
        }
        default: errors.push(unknownFieldError(child.name, 'PullRequest'));
      }
    }
    return out;
  }

  private resolveIssueConnection(repo: Repo, field: FieldNode, errors: Array<{ message: string }>): Record<string, unknown> {
    let issues = [...repo.issues];
    const states = field.args.states;
    if (Array.isArray(states) && states.length) {
      const wanted = new Set(states.map((s) => String(s).toUpperCase()));
      issues = issues.filter((x) => wanted.has(this.issueState(x)));
    }
    const orderBy = field.args.orderBy as Record<string, unknown> | undefined;
    const dir = orderBy && String(orderBy.direction ?? '').toUpperCase() === 'DESC' ? -1 : 1;
    issues.sort((a, b) => (a.number - b.number) * dir);
    const after = field.args.after;
    if (typeof after === 'string' && after !== '') {
      try {
        const n = Number(Buffer.from(after, 'base64url').toString('utf8').split(':')[1]);
        if (Number.isFinite(n)) issues = issues.filter((x) => (dir === 1 ? x.number > n : x.number < n));
      } catch { /* ignore a bad cursor */ }
    }
    const first = typeof field.args.first === 'number' ? field.args.first : issues.length;
    const page = issues.slice(0, first);
    const hasNext = issues.length > page.length;
    const conn: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'nodes') {
        conn[child.alias] = page.map((issue) => this.resolveIssue(repo, issue, child.children, errors));
      } else if (child.name === 'edges') {
        conn[child.alias] = page.map((issue) => ({
          cursor: Buffer.from(`cursor:${issue.number}`, 'utf8').toString('base64url'),
          node: this.resolveIssue(repo, issue, child.children.filter((c) => c.name === 'node').flatMap((c) => c.children), errors),
        }));
      } else if (child.name === 'pageInfo') {
        const info: Record<string, unknown> = {};
        for (const sub of child.children) {
          if (sub.name === 'hasNextPage') info[sub.alias] = hasNext;
          else if (sub.name === 'hasPreviousPage') info[sub.alias] = false;
          else if (sub.name === 'endCursor') info[sub.alias] = page.length ? Buffer.from(`cursor:${page[page.length - 1]!.number}`, 'utf8').toString('base64url') : null;
          else if (sub.name === 'startCursor') info[sub.alias] = page.length ? Buffer.from(`cursor:${page[0]!.number}`, 'utf8').toString('base64url') : null;
        }
        conn[child.alias] = info;
      } else if (child.name === 'totalCount') {
        conn[child.alias] = issues.length;
      } else {
        errors.push(unknownFieldError(child.name, 'IssueConnection'));
      }
    }
    return conn;
  }

  private resolvePullConnection(repo: Repo, field: FieldNode, errors: Array<{ message: string }>): Record<string, unknown> {
    let pulls = [...repo.pulls];
    const states = field.args.states;
    if (Array.isArray(states) && states.length) {
      const wanted = new Set(states.map((s) => String(s).toUpperCase()));
      pulls = pulls.filter((x) => wanted.has(this.pullState(x)));
    }
    const orderBy = field.args.orderBy as Record<string, unknown> | undefined;
    const dir = orderBy && String(orderBy.direction ?? '').toUpperCase() === 'DESC' ? -1 : 1;
    pulls.sort((a, b) => (a.number - b.number) * dir);
    const first = typeof field.args.first === 'number' ? field.args.first : pulls.length;
    const page = pulls.slice(0, first);
    const conn: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.name === 'nodes') {
        conn[child.alias] = page.map((pull) => this.resolvePull(repo, pull, child.children, errors));
      } else if (child.name === 'pageInfo') {
        conn[child.alias] = { hasNextPage: pulls.length > page.length, endCursor: page.length ? Buffer.from(`cursor:${page[page.length - 1]!.number}`, 'utf8').toString('base64url') : null };
      } else if (child.name === 'totalCount') {
        conn[child.alias] = pulls.length;
      } else {
        errors.push(unknownFieldError(child.name, 'PullRequestConnection'));
      }
    }
    return conn;
  }

  // ---------------------------------------------------------------- mutations
  private runMutation(fields: FieldNode[]): { data: unknown; errors?: Array<{ message: string }> } {
    const data: Record<string, unknown> = {};
    const errors: Array<{ message: string }> = [];
    for (const field of fields) {
      const input = (field.args.input ?? {}) as Record<string, unknown>;
      if (field.name === 'createIssue') {
        const repoId = this.forge.decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = repoId ? this.forge.findRepoById(repoId.repoId) : undefined;
        if (!repo) { errors.push({ message: 'Could not resolve to a Repository with the id provided.' }); data[field.alias] = null; continue; }
        const created = this.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) { errors.push({ message: created.error }); data[field.alias] = null; continue; }
        const issueOut: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.name === 'issue') issueOut[child.alias] = this.resolveIssue(repo, created, child.children, errors);
        }
        data[field.alias] = issueOut;
      } else if (field.name === 'closeIssue') {
        const decoded = this.forge.decodeGlobalId(String(input.issueId ?? ''));
        const repo = decoded ? this.forge.findRepoById(decoded.repoId) : undefined;
        const issue = repo?.issues.find((x) => x.number === decoded?.num);
        if (!issue || !repo) { errors.push({ message: 'Could not resolve to an Issue with the id provided.' }); data[field.alias] = null; continue; }
        issue.state = 'closed';
        issue.updated_at = isoNow();
        const issueOut: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.name === 'issue') issueOut[child.alias] = this.resolveIssue(repo, issue, child.children, errors);
        }
        data[field.alias] = issueOut;
      } else if (field.name === 'createPullRequest') {
        const repoId = this.forge.decodeGlobalId(String(input.repositoryId ?? ''));
        const repo = repoId ? this.forge.findRepoById(repoId.repoId) : undefined;
        if (!repo) { errors.push({ message: 'Could not resolve to a Repository with the id provided.' }); data[field.alias] = null; continue; }
        const created = this.forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? 'main'));
        if ('error' in created) { errors.push({ message: created.error }); data[field.alias] = null; continue; }
        const pullOut: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.name === 'pullRequest') pullOut[child.alias] = this.resolvePull(repo, created, child.children, errors);
        }
        data[field.alias] = pullOut;
      } else if (field.name === 'mergePullRequest') {
        const decoded = this.forge.decodeGlobalId(String(input.pullRequestId ?? ''));
        const repo = decoded ? this.forge.findRepoById(decoded.repoId) : undefined;
        const pull = repo?.pulls.find((x) => x.number === decoded?.num);
        if (!pull || !repo) { errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' }); data[field.alias] = null; continue; }
        const merged = this.forge.mergePull(repo, pull);
        if ('error' in merged) { errors.push({ message: merged.error }); data[field.alias] = null; continue; }
        const pullOut: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.name === 'pullRequest') pullOut[child.alias] = this.resolvePull(repo, pull, child.children, errors);
        }
        data[field.alias] = pullOut;
      } else if (field.name === 'addComment') {
        const decoded = this.forge.decodeGlobalId(String(input.subjectId ?? ''));
        const repo = decoded ? this.forge.findRepoById(decoded.repoId) : undefined;
        const issue = repo?.issues.find((x) => x.number === decoded?.num);
        if (!issue || !repo) { errors.push({ message: 'Could not resolve to an Issue with the id provided.' }); data[field.alias] = null; continue; }
        repo.commentCounter += 1;
        const comment = { id: repo.commentCounter, body: String(input.body ?? ''), user: VIEWER_LOGIN, created_at: isoNow(), updated_at: isoNow() };
        issue.comments.push(comment);
        const commentOut: Record<string, unknown> = {};
        for (const child of field.children) {
          if (child.name === 'commentEdge') {
            const edge: Record<string, unknown> = {};
            for (const sub of child.children) {
              if (sub.name === 'node') {
                const node: Record<string, unknown> = {};
                for (const f of sub.children) {
                  if (f.name === 'id') node[f.alias] = this.forge.globalId('IssueComment', repo, issue.number * 1000 + comment.id);
                  else if (f.name === 'body') node[f.alias] = comment.body;
                  else errors.push(unknownFieldError(f.name, 'IssueComment'));
                }
                edge[sub.alias] = node;
              }
            }
            commentOut[child.alias] = edge;
          }
        }
        data[field.alias] = commentOut;
      } else {
        errors.push(unknownFieldError(field.name, 'Mutation'));
        data[field.alias] = null;
      }
    }
    return errors.length ? { data, errors } : { data };
  }
}
