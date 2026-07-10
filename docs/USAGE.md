# Using Sojourn — the complete guide

> Retrace and rewind your agent's path.

Sojourn records everything your agentic coding CLI does — every prompt, tool call, decision, and assumption — into a persistent, cross-session **decision graph**, snapshots your whole working tree at each step, **flags the nodes where the agent guessed or likely got it wrong**, and lets you **check out any node** (filesystem + conversation) into a fresh worktree and branch from there.

Everything runs on `localhost`. No account, no upload, no telemetry.

**The core loop:** *spot where the agent guessed or slipped → rewind to just before it → branch correctly.*

---

## 1. Install & first run

From this repository:

```bash
npm install
npm run build
npm link -w @sojourn/cli        # makes `soj` available on your PATH
soj start                       # starts the daemon (detached), waits for health
soj open                        # opens the web UI at http://localhost:4177
```

That's it. The daemon now passively watches `~/.claude/projects/**/*.jsonl` and ingests every Claude Code session on this machine — past files already on disk and new activity as it happens. **Capture never blocks, modifies, or slows your agent session**; if the daemon is down, your CLIs are completely unaffected.

Check it's alive:

```bash
soj status        # daemon pid + health
soj projects      # projects Sojourn has captured
```

Work in Claude Code for a bit, then open the web UI — your session appears as a tree of nodes.

## 2. Concepts in 60 seconds

| Term | Meaning |
|---|---|
| **Node** | One event: a prompt, assistant message, tool call, tool result, or a user-marked decision/assumption/checkpoint. Node ids look like `claude:<uuid>` / `opencode:<id>`. |
| **Graph** | All nodes for a project, across every session and both CLIs, linked by parentage. Parallel tool calls are siblings (fan-out), never dropped. |
| **Snapshot** | A whole-working-tree git tree hash taken at node boundaries, stored in a **shadow git repo** under `~/.sojourn/snapshots/<projectId>/` — never your project's `.git`. |
| **Flag** | A per-node warning. **Verified** (Tier 1) = deterministic ground-truth check, on by default. **Advisory** (Tier 2) = opt-in LLM critic, always hedged. |
| **Restore** | Check out a node: safety-snapshot current state → restore that node's tree into a **new** worktree under `~/.sojourn/worktrees/` → get the native resume command. |

## 3. The `soj` CLI — full reference

```
soj start                        Start the daemon (detached; pidfile in $SOJOURN_HOME/daemon.pid)
soj stop                         Stop the daemon (verifies the pid actually belongs to Sojourn)
soj status                       Daemon pid + health check
soj open                         Print + open the web UI URL

soj projects                     List captured projects (id, root, name)

soj flags [--project <id>] [--all]
                                 List active confidence flags with kind, tier, confidence,
                                 node id, and evidence. Defaults to the project for your cwd.
                                 --all includes auto-resolved flags (annotated).

soj critic <nodeId>              Run the Tier-2 advisory critic on one node.
                                 Requires ANTHROPIC_API_KEY set on the DAEMON's environment.
                                 Prints advisory flags, or the daemon's error (e.g. missing key).

soj mark <label> [--kind decision|assumption|checkpoint] [--session <id>]
                                 Insert a first-class marker node at the tip of a session.
                                 Default kind: decision. Default session: latest in cwd's project.

soj checkpoint <name> [--session <id>]
                                 Shorthand for `soj mark <name> --kind checkpoint`.

soj restore <nodeId>             PREFLIGHT ONLY: prints the target snapshot, validity, the full
                                 side-effect warning list, and the resume command — then exits 1
                                 without touching anything.
soj restore <nodeId> --yes       Actually restore: safety snapshot → new worktree → prints the
                                 worktree path and resume command.
```

Node ids come from `soj flags` output or the web UI inspector. They contain a `:`— quote them if your shell cares.

## 4. The web UI

`soj open` → `http://localhost:4177` (served by the daemon from `packages/web/dist`).

- **Graph view** — the session tree, laid out top-down. Nodes are color-coded by kind; Claude nodes have solid borders, OpenCode nodes dashed. The latest node of each session carries a "you are here" marker. Updates live over WebSocket while you work.
- **Flag badges** — a **solid red badge with a count** means verified flags; a **muted amber outline badge** means advisory. They are deliberately impossible to confuse. Auto-resolved flags leave the badge counts.
- **Toolbar** — project selector, **decision lens** (collapse the graph to decision/assumption/checkpoint *and flagged* nodes — the "how did we get here, and where did it guess?" view), and a flagged-only filter.
- **Inspector** (click a node) — summary, raw payload, **on-demand file diff** for that node's step, annotations (add free-text notes), and every flag with its evidence. Dismiss buttons remember your dismissals. A **"Run advisory critic"** button triggers the T2 pass for that node.
- **Restore buttons** — *"Restore at this node"* (the node's own snapshot) and, from a flag, *"Restore to before this node"* (the parent's snapshot — i.e. just before the flagged step). Both show a modal with the daemon's warning list verbatim; nothing happens until you confirm.

## 5. Confidence flags

### Verified (Tier 1) — on by default, deterministic, evidence attached

| Flag | Fires when |
|---|---|
| `edit_claim_mismatch` | The agent claimed it edited/created/deleted a file, but the turn's snapshot diff shows otherwise. **The flagship.** |
| `package_hallucination` | A newly imported package doesn't exist on npm/PyPI (path aliases like `@/…` and local Python modules are excluded first). |
| `symbol_not_found` | The agent named a symbol in a specific file, and that file doesn't contain it. |
| `file_ref_missing` | The agent cited a file path that doesn't exist in the tree. |
| `test_claim_unverified` | The agent said "tests pass" but no test run was observed this turn (medium), or the observed run actually failed (high). |

Every verified flag carries **evidence** naming both the claim and the ground truth (e.g. *"claimed edit to `auth.py`; snapshot diff shows no change to that file"*). Flags **auto-resolve** when a later node fixes the issue — resolved flags disappear from badges and `soj flags` (use `--all` to see them annotated).

Verified flags are tuned for **precision over recall**: when ground truth is unavailable (no snapshot yet, first turn of a session, registry unreachable), Sojourn stays **silent** rather than guessing. A missing flag is normal; a firing flag means something.

### Advisory (Tier 2) — opt-in LLM critic

Set `ANTHROPIC_API_KEY` in the **daemon's** environment (restart `soj start` after), then run per-node via the Inspector button or `soj critic <nodeId>`. It surfaces:

- `unstated_assumption` — choices made without being asked ("**Assumed:** …"), presented neutrally, never as failures.
- `possible_hallucination` — claims the critic thinks may be false.

Advisory flags never claim high confidence and are visually distinct everywhere. Model override: `SOJOURN_CRITIC_MODEL` (default `claude-haiku-4-5-20251001`).

### The honest capability statement

> Sojourn's **verified** flags are deterministic ground-truth checks — when they fire, they're almost always right. Sojourn's **advisory** flags come from an optional LLM pass; they surface things worth a look but are **not** authoritative and will sometimes be wrong in both directions. Sojourn will **not** catch every hallucination, and **a clean node is not a guarantee of correctness**. The feature is a high-signal assistant for reviewing agent work, not a correctness proof.

## 6. Restore — semantics and guarantees

Every restore, in order:

1. **Safety snapshot** of your current working tree (automatic, always — Sojourn is never the source of data loss).
2. **Freshness validation** — the target snapshot hash must exist in the shadow repo, or the restore refuses.
3. **New worktree** at `~/.sojourn/worktrees/<projectId>/<node>-<timestamp>/` with the node-time file state, plus a `.sojourn-restore.json` manifest. Your project directory and your `.git` are **never touched**.
4. You get the **native resume command** — e.g. `claude --resume <sessionId> --fork-session` — to continue the conversation in the restored worktree.

**What restore cannot undo** (the preflight warns you every time): Bash side effects (`rm`, `mv` outside the tree), database migrations, network calls, `git push`.

**Conversation caveat:** native CLIs can only fork a resumed conversation from the session's current tip, so the resumed *conversation* continues from where the session left off, while the *filesystem* in the worktree is exactly the node you chose.

## 7. Claude Code integration

The pull-based transcript watcher is the **source of truth** — Sojourn works with zero Claude Code configuration. The plugin in `plugins/claude/` adds two optional things:

1. **Push-timing hooks** (`SessionStart` / `PostToolUse` / `Stop`) that ping the daemon so ingestion is immediate instead of debounce-delayed. The hook script always exits 0 within ~3 seconds, daemon up or not — it can never break your session.
2. **The `sojourn` skill** (`plugins/claude/skills/sojourn/`) that teaches Claude Code itself how to drive `soj` — so you can ask Claude "any flags on this session?" or "rewind to before that bad refactor" and it knows what to do.

Install (in-repo checkout; marketplace packaging is post-V1 — see `plugins/claude/README.md`):

```bash
claude plugin install /Users/you/path/to/sojourn/plugins/claude   # or add via /plugin in Claude Code
```

The hooks assume the repo stays where the plugin path points (`${CLAUDE_PLUGIN_ROOT}/../../packages/adapter-claude/dist/...`), so build the repo first.

## 8. OpenCode integration

`POST /api/hooks/opencode {sessionId}` makes the daemon pull that session's messages from the local OpenCode server (`OPENCODE_URL`, default `http://localhost:4096`) and ingest them into the same per-project graph — Claude and OpenCode nodes unify by repository. `plugins/opencode/sojourn.ts` forwards session events to that route. Set `SOJOURN_OPENCODE=1` to have the daemon also subscribe to OpenCode's `/event` SSE stream directly (off by default).

**Honesty note:** the OpenCode adapter was written against OpenCode's documented API and is **not yet live-integration-tested**; every module carries that header, and everything fails soft (an unreachable OpenCode server is logged and ignored).

## 9. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SOJOURN_HOME` | `~/.sojourn` | Runtime state: SQLite DB, shadow snapshot repos, worktrees, pidfile. |
| `SOJOURN_PORT` | `4177` | Daemon HTTP/WS port. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code transcripts are watched (`<dir>/projects/**/*.jsonl`). |
| `ANTHROPIC_API_KEY` | — | Enables the Tier-2 advisory critic (set on the daemon). |
| `SOJOURN_CRITIC_MODEL` | `claude-haiku-4-5-20251001` | Model the critic calls. |
| `OPENCODE_URL` | `http://localhost:4096` | Local OpenCode server base URL. |
| `SOJOURN_OPENCODE` | off | `1` = daemon subscribes to OpenCode's SSE event stream. |
| `SOJOURN_DAEMON_ENTRY` | auto-resolved | Override the daemon entry script `soj start` spawns. |

## 10. HTTP & WebSocket API

The daemon exposes a full local API (projects, graph, node diffs, flags/run, preflight/restore, annotations, mark, dismiss, hooks) plus `node_added` / `flags_updated` / `project_updated` WebSocket events — see [docs/API.md](API.md) for the route table and payload shapes. Everything the CLI and web UI do goes through this API, so you can script against it.

## 11. Troubleshooting

- **`soj` not found** — run `npm link -w @sojourn/cli`, or call `node packages/cli/dist/main.js …` directly.
- **"daemon is not reachable … Try `soj start`"** — the daemon isn't running (or is on a different `SOJOURN_PORT`).
- **No projects appear** — the watcher only sees sessions under `CLAUDE_CONFIG_DIR`; check `soj status`, then look at the daemon log output. Snapshots additionally require the project root to still exist on disk.
- **A node shows no diff / flags stay silent** — expected when that step has no snapshot ground truth (e.g. the very first turn); precision over recall means silence, not guessing.
- **`soj critic` returns an error** — `ANTHROPIC_API_KEY` must be set in the environment of the *daemon* process, not your shell; restart it after setting.
- **Stale pidfile after a crash** — `soj start`/`soj stop` detect a recycled PID (process identity check) and clean up automatically; they will never signal a non-Sojourn process.
- **Restore refused** — the preflight found no valid snapshot for that node (or its ancestors). Nothing was changed; pick a node that carries a snapshot (the UI shows diffs only on such nodes).
- **Everything broke, where's my data?** — the DB and snapshots live under `~/.sojourn`; your project tree and `.git` are never written to by capture or restore. Safety snapshots taken before every restore are in the shadow repo (`refs/sojourn/head` history).
