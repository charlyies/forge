# forge — a standalone, GitHub-compatible git forge

A single Node 22 process (no dependencies, no git binary, no network) serving
the four surfaces agents already speak, from its own in-memory store:

- **git smart HTTP** — upload-pack protocol v2 (`ls-refs`, `fetch` with
  shallow/deepen, sideband framing) and receive-pack v0 (`report-status`,
  `side-band-64k`, `delete-refs`), over a real git object store: loose objects,
  packfile read (OFS/REF deltas) and write, reachability with have/shallow
  negotiation, fast-forward enforcement per ref.
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents (with
  real commit/tree/blob objects), git refs, labels, issues, comments, pull
  requests (diff, files, squash merge with file-level 3-way conflict
  detection), pagination with `Link` headers, JSON errors and
  `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** (`/api/graphql`) — the documents `gh` and
  `github-mcp-server` send: `viewer`, `repository`, `node`, `__type`
  introspection, issue/PR connections with cursors, and the `createIssue`,
  `closeIssue`, `createPullRequest`, `mergePullRequest`, `addComment`
  mutations, plus batched operations.
- **MCP** (`/mcp`) — Streamable HTTP JSON-RPC 2.0, modern `server/discover`
  (2026-07-28) and the legacy `initialize` handshake, with eight tools
  (`create_repo`, `get_repo`, `list_repos`, `create_issue`, `list_issues`,
  `get_issue`, `create_pull_request`, `merge_pull_request`).

## Layout

- `main.ts` — the trial lifecycle: bind an ephemeral port, register it with
  the env, poll `/done`, exit 0. (With `LOCAL_PORT` set and no
  `MAKEFUN_ENV_URL`, it serves standalone for local grading.)
- `app.ts` — the HTTP server: routing, REST handlers, git endpoints.
- `git.ts` — the git core: objects, packs, pkt-lines, fetch negotiation.
- `store.ts` — the model: repos, refs, issues, pull requests, merges.
- `graphql.ts` — the GraphQL parser and executor.
- `mcp.ts` — the MCP endpoint and tools.

## Local grade

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 LOCAL_PORT=8471 node --experimental-strip-types main.ts &
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:8471 --token test-token-123 --perf
```

Local result: **120/120 checks, 902/1000** (feature 600, agent 200, perf 102).

## Auth

Every API call presents `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the
token names the viewer `adaiversen` (the scenario's fixed viewer login).
A repository under any other owner is 404, never 403.
