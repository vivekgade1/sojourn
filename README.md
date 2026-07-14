# Sojourn v1.2.0

> Retrace and rewind your agent's path.

Sojourn records everything your agentic coding CLI does — every prompt, tool call, decision, and assumption — into a persistent, cross-session **decision graph**, and snapshots your **whole working tree** at every step into a shadow git repo that never touches your `.git`. Deterministic **verified flags** catch the nodes where the agent's claims don't match reality ("I edited `auth.py`" — the snapshot diff says otherwise), and any node can be **restored** — filesystem *and* conversation — into a fresh worktree to branch from. It is local-first (localhost only, no accounts, no uploads) and cross-CLI by design: Claude Code and OpenCode sessions share one graph per repository.

**The core loop:** *spot where the agent guessed or slipped → rewind to just before it → branch correctly.*

- Complete user guide: [docs/USAGE.md](docs/USAGE.md) — CLI reference, web UI tour, flag semantics, restore guarantees, troubleshooting.
- HTTP/WS API: [docs/API.md](docs/API.md).
- Claude Code plugin details: [plugins/claude/README.md](plugins/claude/README.md).

> **Install status:** Sojourn is not published to npm yet. You install it from this repository — clone, build, link. Everything below assumes that.

## What's in v1.2.0

v1.2.0 is the complete V1 + V2 feature set, hardened for daily use. Everything runs locally against one daemon; nothing leaves your machine. At a glance:

**Capture & navigation**
- Passive, cross-session, cross-CLI **decision graph** with whole-working-tree shadow-git **snapshots at every step** — never touching your project's `.git`.
- Web UI (`soj open`) with a **map view** (turn waypoints sized by work, flag badges, decision pennants, minimap, search) and a **graph view** (node tree with lineage highlighting and a path breadcrumb).
- **Multi-select session filter** — the UI opens on the latest session only (fast on large histories) and lets you union in more sessions or show all.
- **Restore-point highlighting** — nodes you can restore to are visually marked; nodes whose snapshot is gone (thinned by GC or never captured) are muted and their restore button is **disabled up front**, not after a dead-end click.
- **"Restorable" filter** — isolate just the actionable nodes (where restore can be performed) in a distinct color palette, across both views.
- Live WebSocket updates with **automatic reconnect + refetch** and a "daemon unreachable" banner that self-clears on recovery.

**Trust — verified vs advisory flags**
- Five deterministic **verified** checks (edit-claim-mismatch flagship, package hallucination, symbol / file-ref grounding, test-claim verification) with evidence, auto-resolve, and per-turn budgets/digests; an opt-in Tier-2 LLM critic that can never masquerade as verified.

**Restore, rewind & harvest**
- Whole-tree **restore** into an isolated worktree (safety snapshot first, your `.git` untouched); **exact-node conversation rewind** for Claude Code with honest refusal; **harvest** a worktree's changes back to mainline (HTTP API).

**Decision memory, gate & retention**
- `soj why` / `soj decisions` full-text search + a files-touched index; `soj mcp` read-only MCP server; `soj gate` CI-style exit codes; `soj gc` pin-aware retention with dry-run default.

**Reliability (hardened in v1.2.0)**
- The daemon is crash-proofed: a **rotating log** at `~/.sojourn/daemon.log`, process guards that **log and survive** (one bad transcript can never take capture down, with a crash-storm breaker), and `soj start` / `soj status` that surface the log tail when something is wrong instead of failing silently. A prior O(n²) ingest path that could OOM the daemon on very large sessions is **fixed and guarded by a scale test**. The daemon binds **loopback (127.0.0.1) only** — its write routes are never reachable from the network.

Each feature below carries the exact command or surface. Every command is real and copy-pasteable.

## Quick start

### 1. Build and start the daemon

```bash
git clone <this-repo> sojourn
cd sojourn
npm install
npm run build                   # tsc for all packages + web UI + plugin hook bundle
npm link -w @sojourn/cli        # puts `soj` on your PATH
                                # (or skip linking and run: node packages/cli/dist/main.js)
soj start                       # starts the daemon detached, waits for health
soj open                        # web UI at http://localhost:4177
```

That's it for capture. The daemon passively watches `~/.claude/projects/**/*.jsonl` (honors `CLAUDE_CONFIG_DIR`) and ingests every Claude Code session on the machine — transcripts already on disk and new activity as it happens. Capture never blocks, modifies, or slows your agent session; if the daemon is down, your CLIs are completely unaffected. Runtime state lives in `~/.sojourn` (`SOJOURN_HOME` to override; `SOJOURN_PORT` for the port, default 4177).

```bash
soj status        # daemon pid + health
soj projects      # projects Sojourn has captured
```

### 2. Add the Claude Code plugin (optional, recommended)

The transcript watcher is the source of truth — Sojourn works with **zero** Claude Code configuration. The plugin in [`plugins/claude/`](plugins/claude/README.md) adds push-timing hooks (ingestion becomes immediate instead of debounce-delayed) and a `sojourn` skill that teaches Claude Code to drive `soj` itself. Two install modes:

**From your repo checkout** (after `npm run build` above):

```bash
claude plugin install /path/to/sojourn/plugins/claude   # or add via /plugin in Claude Code
```

**From a copied plugin directory** — `plugins/claude/` is a self-contained bundle; the hook script (`hooks/sojourn-hook.mjs`) is a generated, dependency-free artifact, so a copied directory needs no `npm install` and no build:

```bash
cp -r plugins/claude ~/wherever/sojourn-claude-plugin
claude plugin install ~/wherever/sojourn-claude-plugin
```

Either way the hook always exits 0 within ~3.5 seconds, daemon up or not — it can never break a session. A running daemon (`soj start`) is what actually records anything.

### 3. Your first five minutes

1. **Run a Claude Code session** in any repo — ask it to make a small change.
2. **Watch it appear.** `soj projects` lists the repo; `soj open` shows the session in the web UI's map view: each session is a dotted trail, each waypoint one turn, sized by how much work happened. The newest turn carries the "you are here" pin.
3. **Check the flags.** `soj flags` prints active flags with kind, tier, node id, and evidence (`--all` includes auto-resolved ones, annotated). Verified flags also appear as solid red badges on waypoints; advisory ones as muted amber outlines — deliberately impossible to confuse.
4. **Click a waypoint.** A drawer opens with the turn's steps as chips; click a chip to inspect the node — summary, raw payload, on-demand file diff, annotations, and every flag with its evidence.
5. **Try a restore preflight** (it's read-only without `--yes`):

   ```bash
   soj restore <nodeId>          # preflight ONLY: prints the full side-effect warning
                                 # list (incl. whether the snapshot is missing/thinned)
                                 # and the resume command — exits 1, touching nothing
   soj restore <nodeId> --yes    # actually restore: safety snapshot -> new worktree
   ```

   Node ids come from `soj flags` output or the web UI inspector.

## Features

### Capture and the map

Every prompt, assistant message, tool call, tool result, and user mark becomes a node in one graph per repository, across every session and both CLIs, linked by parentage — parallel tool calls are kept as siblings, never dropped. At each node boundary the whole working tree is snapshotted (`.gitignore`-aware, secrets excluded) into a shadow git repo under `~/.sojourn/snapshots/<projectId>/` — never your project's `.git`.

`soj open` gives you two views: the **map view** (turn-level waypoints with flag badges, decision pennants, a minimap, and search) and the **graph view** (the raw node tree with lineage highlighting and a clickable path breadcrumb). Both open on the **latest session only** — a multi-select **session filter** lets you union in more or show all, so a repo with hundreds of turns across many sessions stays fast and legible. Search, the decision/flagged lenses, and the filters all compose.

Two navigation aids make restore actionable at a glance:

- **Restore-point highlighting** — every node carries whether it can actually be restored (its snapshot, or the nearest ancestor's, still exists). Restorable nodes are marked; nodes whose snapshot was thinned by GC or never captured are muted, and their restore button is disabled up front with a tooltip — no more clicking into a dead-end "snapshot no longer valid" dialog.
- **"Restorable" filter** — a toolbar toggle that isolates just the actionable nodes (where restore can be performed) in a distinct action color palette, in both the map and graph.

The UI reconnects on its own if the daemon restarts, refetches so you never see a stale graph, and shows a clear "daemon unreachable — run `soj start`" banner while it's down. Mark moments worth finding later:

```bash
soj mark "chose sqlite over postgres" --kind decision   # also: assumption
soj checkpoint "before the big refactor"
```

### Verified vs advisory flags — the honesty contract

Two tiers with different promises, and the product never blurs them:

**Verified (Tier 1)** — deterministic ground-truth checks, on by default, evidence attached, tuned for **precision over recall** (no ground truth means silence, not a guess):

| Flag | Fires when |
|---|---|
| `edit_claim_mismatch` | The agent claimed it edited/created/deleted a file; the turn's snapshot diff shows otherwise. **The flagship.** |
| `package_hallucination` | A newly imported package doesn't exist on npm/PyPI. |
| `symbol_not_found` | A named symbol is absent from the file the agent said it's in. |
| `file_ref_missing` | A cited path doesn't exist in the tree. |
| `test_claim_unverified` | "Tests pass," but no test run was observed — or the observed run failed. |

Verified flags **auto-resolve** when a later node fixes the issue. Flag storms can't bury the signal: per-kind, per-turn **budgets** (the flagship gets the largest budget — 10, other verified kinds 3, advisory 2) collapse identical-claim repeats, and overflow becomes a single **digest** flag per kind carrying a suppressed count. Digests never mix kinds or tiers.

**Advisory (Tier 2)** — an opt-in LLM critic (set `ANTHROPIC_API_KEY` in the *daemon's* environment, then use the Inspector button or `soj critic <nodeId>`). It surfaces unstated assumptions and possible hallucinations — always hedged, always visually distinct, never presented as verified.

> Sojourn's verified flags are almost always right when they fire, because they compare claims to what actually happened on disk and in the registries. Advisory flags are worth a look but not authoritative. Sojourn will **not** catch every hallucination, and **a clean node is not a guarantee of correctness** — it's a high-signal assistant for reviewing agent work, not a correctness proof.

### Restore and exact rewind

Every restore, in order: **safety snapshot** of your current tree (automatic, always) → **freshness validation** of the target snapshot → checkout into a **new worktree** under `~/.sojourn/worktrees/` → you get the **native resume command**. Your project directory and your `.git` are never touched.

Conversation restore has two modes for Claude Code:

- **Exact rewind** — the daemon synthesizes a brand-new transcript containing only the chain from root to your chosen node (originals are never mutated), and the resume command becomes `claude --resume <newSessionId>`: the conversation genuinely starts at that node.
- **Tip mode** — the fallback: `claude --resume <sessionId> --fork-session`, continuing from wherever the session currently stands, while the *filesystem* in the worktree is still restored exactly to your chosen node.

Sojourn **refuses exact rewind honestly** — with a `refusedReason` — whenever it can't guarantee the reconstruction: an incomplete ancestor chain, a parentage cycle, or a chain crossing a compaction boundary. OpenCode sessions always restore in tip mode. And the preflight warns you every time about what no restore can undo: Bash side effects, DB migrations, network calls, `git push`.

### Harvest — the return path (HTTP API only today)

When work in a restore worktree turns out to be worth keeping, **harvest** merges it back into your mainline project — the only Sojourn feature that ever writes into your actual project directory, and it takes a mainline safety snapshot first, unconditionally, in every mode. There is **no `soj harvest` subcommand yet in this release** — harvest is driven entirely through the HTTP API:

```bash
# dry run: classify every changed file as clean / conflict / identical
curl -s -X POST localhost:4177/api/worktrees/harvest/preflight \
  -H 'content-type: application/json' \
  -d '{"worktreePath":"'$HOME'/.sojourn/worktrees/<projectId>/<worktree>"}'

# apply clean changes onto the mainline (aborts whole on conflict unless allowConflicts),
# or mode "patch" to write a .sojourn-harvest.patch inside the worktree instead
curl -s -X POST localhost:4177/api/worktrees/harvest \
  -H 'content-type: application/json' \
  -d '{"worktreePath":"...","mode":"apply"}'
```

Failures are typed and honest (`no_manifest`, `stale_base`, `conflicts`, `patch_incomplete`, `partial_apply`, `mainline_drift`) — a mid-apply failure never leaves a half-applied mainline pretending to be a success. A successful apply that lands at least one file also lands a checkpoint node in the graph, parented to the restore's origin (an all-identical apply changes nothing and adds no node). Full semantics and known limits: [docs/USAGE.md §7](docs/USAGE.md).

### Decision memory — `soj why`, `soj decisions`, `soj mcp`

Prompts, gists, marks, and annotations are indexed into full-text search as they're captured, plus a files-touched index per node — so "why did we do X" is answerable months later:

```bash
soj why "why sqlite over postgres"        # full-text search, best match first
soj why "auth flow" --file src/auth.ts    # only turns that touched this file
soj decisions                             # marks + turns still carrying an active flag
```

And any agentic CLI can query the graph itself via a local, **read-only** MCP stdio server:

```bash
claude mcp add sojourn -- soj mcp
```

Four tools — `sojourn_search`, `sojourn_decisions`, `sojourn_flags`, `sojourn_node` — all backed by the daemon HTTP API, never the database directly. Daemon down means friendly guidance text, not a protocol error.

### `soj gate` — CI-style verification

```bash
soj gate                        # exit 0 clean | 2 active verified flags | 3 daemon unreachable
soj gate --session <id>         # gate one session
soj gate --include-advisory     # opt advisory flags into the gate too
```

Every run prints the same honest header first: `checked: claims vs snapshots recorded by the local Sojourn daemon` — the gate proves recorded claims against snapshots, nothing more. Exit 3 (could not check) is deliberately distinct from exit 0 (passed): "could not check" is never reported as "clean."

### Retention and GC — `soj gc`

```bash
soj gc                                    # dry-run preview (default), 30-day keep window
soj gc --days 14                          # shorter window
soj gc --archive-dir ~/sojourn-archive --run   # on --run, writes a git-bundle backup before pruning
soj gc --run                              # actually prune
```

Never pruned, regardless of age: snapshots pinned by decision/assumption/checkpoint nodes, flagged nodes, live restored worktrees (their manifests are scanned automatically), and the safety-snapshot history itself. `soj gc` is safe to run against a live daemon — if capture lands a snapshot mid-run, gc detects it and **aborts without pruning anything**; just re-run later.

### Terminal flag delivery

```bash
export SOJOURN_HOOK_FLAGS=1     # in the environment Claude Code runs in
```

With the plugin installed, the `Stop` hook then prints that turn's active **verified** flags straight into your terminal:

```
Sojourn: edit_claim_mismatch — claimed src/x.ts:42 edited, snapshot shows no change
```

Verified-only by contract and by a second in-hook guard (any line mentioning "advisory" is dropped as defense in depth); budgeted to at most 3 lines plus a `+n more` marker; silent when the daemon is slow or down; never changes the hook's exit code.

### Session health

`GET /api/sessions/:id/health` returns pure counts for a session — turns, verified active/resolved, advisory active, dismissed, suppressed — with no scoring or interpretation layered on top. It's what `soj gate --session` reads, and it's there for your own scripts and dashboards too:

```bash
curl -s localhost:4177/api/sessions/<sessionId>/health
```

### Reliability and operations

Capture must never fail loudly or take your agent session with it, so the daemon is built to stay up and stay diagnosable:

- **Rotating log** at `~/.sojourn/daemon.log` (size-capped, one generation kept) — the startup line records pid, version, node version, `SOJOURN_HOME`, and port.
- **Process guards** log and survive: an unhandled error while ingesting a single bad transcript is logged and the daemon keeps running (only a genuine startup failure — DB open, port bind — exits, and a runaway crash storm trips a breaker). Capture is passive by contract.
- **Diagnosable startup:** `soj start` polls health and, on failure, prints the tail of `daemon.log`; `soj status` does the same when the recorded pid is dead — no more silent death.
- **Scale-safe ingest:** a very large session (10k+ steps) ingests in seconds with bounded memory, guarded by a permanent stress test.
- **Loopback-only:** the daemon listens on `127.0.0.1`. Its write routes (restore, harvest, rewind) are single-user-local by design and are never exposed to the network.

## How Sojourn compares

| | Zero setup | Whole-tree snapshots | Cross-session graph | Cross-CLI | Verified claim-checking | Searchable decision memory |
|---|---|---|---|---|---|---|
| **Sojourn** | daemon + optional plugin | yes (shadow git, every step) | yes | Claude Code + OpenCode¹ | yes (deterministic, evidence attached) | yes (`soj why` / MCP) |
| Claude Code checkpoints (`/rewind`) | yes — built in | agent-edit scoped | no — per session | no | no | no |
| OpenCode revert/undo | yes — built in | message-scoped revert | no — per session | no | no | no |
| Plain git discipline | needs habit, no daemon | only when you commit | commits, unlinked from conversation | n/a | no | commit messages only |
| IDE-agent checkpoint features (category) | yes — editor built-ins | varies, typically edit-scoped | typically no | no — that editor only | no | no |

¹ OpenCode capture is implemented but not yet live-integration-tested — see [Honest limits](#honest-limits). Claude Code is the fully exercised path today.

Honest prose version:

- **Claude Code's native checkpoints** are the right tool for the quick mid-session "undo that" — zero setup, in-flow, no daemon. Sojourn adds what they don't attempt: whole-working-tree snapshots at every step, a graph that persists across sessions and CLIs, deterministic verification of the agent's claims, restores into isolated worktrees that never touch your live tree, and searchable decision memory.
- **OpenCode's revert/undo** covers the same in-session ground for OpenCode. Same trade: instant and built-in, but session-scoped and no claim verification.
- **Plain git discipline** (frequent commits, stash, worktrees) is universal and needs no daemon — if you already commit after every agent turn and don't need conversation state linked to file state, it may be all you need. Sojourn's difference is that capture is automatic and per-step without polluting your real history, every snapshot is tied to the exact conversation node that produced it, and flags tell you *which* steps deserve suspicion.
- **IDE-agent checkpoint features** (the checkpoint/restore built into some AI-first editors) are convenient if you live in that editor. They are per-editor and per-session by nature; Sojourn works across CLIs and across time, from the terminal, with verification on top.

If you want zero moving parts, use the native checkpoints. Sojourn earns its daemon when you work across sessions, across tools, or need to *trust but verify* what the agent said it did.

## Honest limits

- **Not on npm yet.** Install is from this repository (clone, build, link). No launchd/system autostart either — `soj start` is manual.
- **OpenCode support is not live-verified.** The adapter was written against OpenCode's documented API and is not yet live-integration-tested; every module carries that header, and everything fails soft. See [docs/USAGE.md §13](docs/USAGE.md).
- **Harvest is API-only** (no `soj harvest` subcommand yet) and transfers file *contents* only — file-mode changes aren't preserved, symlinked branch entries are materialized as regular files, and patch mode emits git's "Binary files differ" stub for binary paths.
- **The critic costs an API key.** Tier-2 advisory flags require `ANTHROPIC_API_KEY` in the daemon's environment and are opt-in, per-node, and advisory-only.
- **Flags are not a correctness proof.** Sojourn will not catch every hallucination; a clean node is not a guarantee. Verified checks stay silent when ground truth is unavailable (precision over recall). No logprob-based detection for Claude Code — the API doesn't expose logprobs, and Sojourn doesn't pretend otherwise.
- **Restore cannot undo side effects** — Bash effects (`rm`, `mv`), DB migrations, network calls, `git push`. The preflight warns you every time.
- **Exact rewind is Claude Code-only** and refuses (with the reason) on orphaned parentage, cycles, or compaction boundaries, falling back to tip mode; OpenCode restores are always tip-mode.

## Architecture

An npm-workspaces monorepo around one external daemon: `packages/core` (graph store on SQLite, shadow-git snapshotter, restore engine, flag engine, harvest, GC) · `packages/daemon` (HTTP/WS API + transcript watchers — the contract is [docs/API.md](docs/API.md)) · `packages/adapter-claude` / `packages/adapter-opencode` (per-CLI ingestion and conversation restore; the transcript is always ground truth, hooks are just timing signals) · `packages/web` (React Flow UI) · `packages/cli` (`soj`) · `plugins/claude` / `plugins/opencode` (install artifacts). Everything the CLI and web UI do goes through the daemon's localhost API, so you can script against all of it. Design spec: [SOJOURN_BUILD_PLAN_V1.md](SOJOURN_BUILD_PLAN_V1.md).

```bash
npm test                        # vitest across all packages
npm run build                   # tsc -b + vite build + plugin hook bundle
bash scripts/e2e/run-cycle.sh   # full E2E cycle against an isolated daemon
```

## Documentation

- [docs/USAGE.md](docs/USAGE.md) — the complete user guide (CLI reference, web UI, flags, restore, harvest, GC, decision memory, gate, MCP, troubleshooting)
- [docs/API.md](docs/API.md) — HTTP + WebSocket API
- [plugins/claude/README.md](plugins/claude/README.md) — Claude Code plugin install modes and hook internals
