# @sojourn/cli — the `soj` command

CLI for the Sojourn daemon (see `docs/USAGE.md` at the repo root for the full
end-user guide). All commands talk to the local daemon over HTTP
(`http://localhost:$SOJOURN_PORT`, default 4177) — nothing leaves your machine.

## Query commands (V2)

```bash
soj why "why sqlite over postgres" [--project <id>] [--file <path>]
    # full-text search over prompts, gists, marks, and annotations;
    # hits print best-first with kind, node id, gist, and a snippet

soj decisions [--project <id>] [--file <path>]
    # the durable record: marked decisions/assumptions/checkpoints
    # plus any turns carrying active flags (evidence attached)

soj gate [--session <id> | --project <id>] [--include-advisory]
    # CI-style check. Exit codes:
    #   0  clean — "gate passed: N turns, 0 active verified flags"
    #   2  active verified flags exist (table with node, kind, tier,
    #      confidence, evidence)
    #   3  daemon unreachable (could not check — distinct on purpose)
    # Advisory (LLM-critic) flags never gate unless --include-advisory.
    # Every run prints the honest header:
    #   "checked: claims vs snapshots recorded by the local Sojourn daemon"
    # — the gate proves recorded claims against snapshots, nothing more.
```

## `soj mcp` — MCP server for agents

`soj mcp` runs a local, **read-only** [MCP](https://modelcontextprotocol.io)
stdio server so agentic CLIs can query the decision graph themselves. It
exposes four tools, each backed by the daemon HTTP API (never the database
directly):

| Tool | Arguments | Returns |
|---|---|---|
| `sojourn_search` | `query`, `file?`, `project?` | relevance-ordered hits (gist + snippet + active flag kinds) |
| `sojourn_decisions` | `project?` | marks (decision/assumption/checkpoint) + actively flagged turns |
| `sojourn_flags` | `sessionId?` | active flags with tier/confidence/evidence |
| `sojourn_node` | `nodeId` | one full node incl. flags and annotations |

If the daemon is down, tools answer with friendly guidance text instead of a
protocol error. The default project is derived from the working directory the
server is launched in.

### Add to Claude Code

```bash
claude mcp add sojourn -- soj mcp
```

Then ask things like *"use sojourn_search to find out why we switched to a
shadow git repo"* from any session in the repo.
