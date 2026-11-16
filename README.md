# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/chuck147147/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/chuck147147/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A one-process GitHub-compatible git forge in TypeScript for Node 22, with zero npm dependencies. It serves the REST v3 APIs (repositories, branches, contents, issues, comments, labels, pull requests with files/diffs/merges), a GraphQL v4 endpoint, a streamable-HTTP MCP endpoint whose tools act on the same store, and git smart HTTP (clone, fetch and push over protocol v0 and v2, with shallow fetch/deepen, pack deltas and sideband progress) — all backed by one in-memory store of canonical git objects, so every surface sees the same data.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the env at `MAKEFUN_ENV_URL`, serves until the env says the trial is done, and exits.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6qzky65m&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
