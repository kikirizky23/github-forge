# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kikirizky23/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kikirizky23/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: one process serving git smart HTTP, the REST v3 API, GraphQL v4 and MCP from its own store. No UI, no outside service, Node 22 standard library only.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=cbprbg0z&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` (protocol v0 and v2, implemented from scratch on `node:zlib` + `node:crypto` — no git binary) |
| anything else | 404 `{"message":"Not Found"}` |

## Lifecycle (main.ts)

`main.ts` is the harness lifecycle and stays as it ships: bind an ephemeral port (`listen(0)`, never 8080), `POST $MAKEFUN_ENV_URL/register` with `{"port": N}`, poll `GET $MAKEFUN_ENV_URL/done` until `{"done":true}`, then exit 0. The server in `app.ts` is the forge.

## Layout

- `main.ts`: the lifecycle. Keep it as it is.
- `app.ts`: the HTTP server — routing, auth (`Authorization: Bearer $MAKEFUN_SHOP_TOKEN` on every API call except `/healthz`).
- `store.ts`: the in-memory store (repos, branches, commits, trees, blobs, issues, PRs, labels) with a deterministic state export.
- `git.ts`: git smart HTTP — pkt-line framing, ref advertisement, packfile read/write (loose objects, deltas), protocol v2 `ls-refs`/`fetch`, `receive-pack`.
- `rest.ts`: REST v3 resources with GitHub-shaped JSON, pagination headers and status codes.
- `graphql.ts`: GraphQL v4 for the `gh` and `github-mcp-server` documents.
- `mcp.ts`: MCP tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

Local grade (practice trial-0, kit's own runner + sealed scorer): **981–982/1000** — feature 600/600, agent 200/200, perf 181–182/200, 120/120 conformance checks pass, state export identical byte-for-byte across two runs.
