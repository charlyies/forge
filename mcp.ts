// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Speaks the modern 2026-07-28 era (server/discover) and the legacy handshake
// (initialize + notifications/initialized). Tools are the github-mcp-server set.
import { isoNow, VIEWER_LOGIN, type Forge } from './store.ts';

export const MCP_SERVER_NAME = 'forge-mcp';
export const MCP_SERVER_VERSION = '1.0.0';
export const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export function publicRepo(repo: NonNullable<ReturnType<Forge['getRepo']>>): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64url'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
  };
}

function textResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(args: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return `missing required argument: ${key}`;
  }
  return null;
}

export function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`unknown tool: ${name}`);
  const missing = missingArgs(args, tool.inputSchema.required);
  if (missing) return errorResult(missing);
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? '');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (!repoNameArg) return errorResult('missing required argument: name');
      if (forge.getRepo(VIEWER_LOGIN, repoNameArg)) return errorResult(`repository ${repoNameArg} already exists`);
      const repo = forge.createRepo(repoNameArg, args.private === true, typeof args.description === 'string' ? args.description : '');
      return textResult(publicRepo(repo));
    }
    case 'get_repo': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      return textResult(publicRepo(repo));
    }
    case 'list_repos': {
      return textResult(forge.listRepos(VIEWER_LOGIN).map((r) => publicRepo(r)));
    }
    case 'create_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const created = forge.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return errorResult(created.error);
      return textResult({
        id: created.id, number: created.number, title: created.title, body: created.body,
        state: created.state, labels: created.labels, user: { login: created.user },
        created_at: created.created_at, updated_at: created.updated_at,
      });
    }
    case 'list_issues': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issues.filter((i) => state === 'all' || i.state === state);
      return textResult(issues.map((i) => ({
        id: i.id, number: i.number, title: i.title, body: i.body, state: i.state,
        labels: i.labels, user: { login: i.user }, created_at: i.created_at, updated_at: i.updated_at,
      })));
    }
    case 'get_issue': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      if (!issue) return errorResult(`issue #${String(args.number)} not found`);
      return textResult({
        id: issue.id, number: issue.number, title: issue.title, body: issue.body,
        state: issue.state, labels: issue.labels, user: { login: issue.user },
        created_at: issue.created_at, updated_at: issue.updated_at,
      });
    }
    case 'create_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const created = forge.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', String(args.head ?? ''), String(args.base ?? ''));
      if ('error' in created) return errorResult(created.error);
      return textResult({
        id: created.id, number: created.number, title: created.title, body: created.body,
        state: created.state, head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
        merged: created.merged, mergeable: created.mergeable,
        created_at: created.created_at, updated_at: created.updated_at,
      });
    }
    case 'merge_pull_request': {
      const repo = forge.getRepo(owner, repoName);
      if (!repo) return errorResult(`repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return errorResult(`pull request #${String(args.pull_number)} not found`);
      const merged = forge.mergePull(repo, pull);
      if ('error' in merged) return errorResult(merged.error);
      return textResult({
        number: pull.number, merged: true, state: pull.state,
        sha: merged.sha, merge_commit_sha: pull.merge_commit_sha, merged_at: pull.merged_at,
      });
    }
    default:
      return errorResult(`unknown tool: ${name}`);
  }
}

export interface McpOutcome { status: number; body: unknown; headers?: Record<string, string> }

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}
function rpcError(id: unknown, code: number, message: string, status = 200): McpOutcome {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/** Handle one POST /mcp body (already parsed JSON, or null when unparsable). */
export function handleMcp(forge: Forge, body: unknown): McpOutcome {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32700, 'Parse error: the request body is not a JSON object', 400);
  }
  const req = body as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;
  if (method === '') {
    // A response or a notification without a method: nothing to answer.
    return { status: 202, body: {} };
  }
  if (method === 'server/discover') {
    return rpcResult(id, {
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_REVISIONS,
      protocolVersion: SUPPORTED_REVISIONS[0],
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_REVISIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      },
      headers: { 'mcp-session-id': `forge-${Date.now().toString(36)}` },
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: {} };
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') return rpcError(id, -32602, 'tools/call needs a tool name');
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `unknown tool: ${name}`);
    const result = callTool(forge, name, args);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

export { isoNow };
