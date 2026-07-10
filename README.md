# Sojourn

> Retrace and rewind your agent's path.

Sojourn is a cross-CLI decision-graph, state-restore, and assumption/hallucination-flagging layer for agentic coding CLIs (v1: **Claude Code** + **OpenCode**). It captures every prompt, tool call, decision, and assumption as a node in a persistent cross-session graph, snapshots your whole working tree at each step, **flags the nodes where the agent guessed or likely got it wrong**, and lets you check out any node — conversation *and* filesystem — into a fresh worktree and branch from there.

Everything runs on localhost. No account, no upload.

**📖 Complete user guide: [docs/USAGE.md](docs/USAGE.md)** — CLI reference, web UI tour, flag semantics, restore guarantees, Claude Code/OpenCode setup, troubleshooting.

## Install & run (from this repo)

```bash
npm install
npm run build
node packages/cli/dist/main.js start     # or: npm link -w @sojourn/cli && soj start
soj open                                  # web UI at http://localhost:4177
```

The daemon watches `~/.claude/projects/**/*.jsonl` (honors `CLAUDE_CONFIG_DIR`) and ingests sessions passively — capture never blocks or modifies your agent session. Runtime state lives in `~/.sojourn` (override with `SOJOURN_HOME`; port with `SOJOURN_PORT`).

### Claude Code plugin (push-timing hooks, optional)

The pull-based watcher is the source of truth; the plugin in `plugins/claude/` just makes ingestion immediate by pinging the daemon on `SessionStart` / `PostToolUse` / `Stop`. The hook script always exits 0 within ~3s, daemon up or not.

### OpenCode

`packages/adapter-opencode` speaks OpenCode's local server API (sessions, messages, revert/fork, `/event` SSE) and `plugins/opencode/sojourn.ts` forwards session events to the daemon, whose `POST /api/hooks/opencode` route pulls that session's messages and ingests them (fail-soft when no OpenCode server is running). Set `SOJOURN_OPENCODE=1` to additionally have the daemon subscribe to OpenCode's `/event` SSE stream directly — off by default, since most environments run no OpenCode server. **This adapter was written against OpenCode's documented API and is not yet live-integration-tested** — every module carries that header, and it fails soft everywhere.

## The CLI

```
soj start | stop | status      # daemon lifecycle
soj open                       # open the web UI
soj projects                   # captured projects
soj flags [--project <id>] [--all]   # active confidence flags with evidence (--all includes auto-resolved)
soj critic <nodeId>            # run the Tier-2 advisory critic on a node (needs ANTHROPIC_API_KEY on the daemon)
soj mark <label> [--kind decision|assumption|checkpoint]
soj checkpoint <name>
soj restore <nodeId> [--yes]   # without --yes: preflight + warnings only
```

## Confidence flags — what they mean

**Verified flags** (Tier 1, on by default) are deterministic ground-truth checks with the claim *and* the evidence attached:

- `edit_claim_mismatch` — the agent said it edited a file; the snapshot diff says otherwise (the flagship).
- `package_hallucination` — a newly imported package doesn't exist on npm/PyPI.
- `symbol_not_found` — a named symbol is absent from the file the agent said it's in.
- `file_ref_missing` — a cited path doesn't exist in the tree.
- `test_claim_unverified` — "tests pass," but no test run was observed (or the observed run failed).

Verified flags auto-resolve when a later node fixes the issue. They are tuned for **precision over recall**: when ground truth is unavailable, Sojourn stays silent rather than guessing.

**Advisory flags** (Tier 2, off by default, requires `ANTHROPIC_API_KEY`) come from an optional LLM critic pass: unstated assumptions ("Assumed: …", presented neutrally, never as failures) and possible hallucinations. Advisory flags are visually distinct from verified flags and never claim high confidence.

> Sojourn's **verified** flags are deterministic ground-truth checks — when they fire, they're almost always right, because they compare the agent's claims to what actually happened on disk and in the registries. The flagship "you said you edited X but you didn't" check is both reliable and genuinely useful. Sojourn's **advisory** flags (unstated assumptions, possible hallucinations) come from an optional LLM pass; they surface things worth a look but are **not** authoritative, will sometimes be wrong in both directions, and are labeled as advisory for that reason. Sojourn will **not** catch every hallucination, and a clean node is **not** a guarantee of correctness. The feature is a high-signal assistant for reviewing agent work, not a correctness proof.

## Restore — what it does and does not undo

Every node checkout: **safety-snapshot your current state → validate the target snapshot exists → restore into a NEW git worktree under `~/.sojourn/worktrees/` → hand you the native resume command** (`claude --resume <session> --fork-session`). Your working tree and your `.git` are never touched; snapshots live in a shadow git repo per project under `~/.sojourn/snapshots/`.

Sojourn restores *conversation* + *whole-tree file state*. It **cannot** undo Bash side effects (`rm`, `mv`), DB migrations, network calls, or `git push` — the preflight panel warns you every time. One caveat on the conversation side: the native CLIs can only fork a resumed conversation from the session's current tip (e.g. `claude --resume … --fork-session`), so the resumed *conversation* continues from where the session left off, while the *filesystem* in the new worktree is restored exactly to the node you chose.

## Architecture

npm-workspaces monorepo: `packages/core` (graph store, shadow-git snapshotter, restore engine, flag engine) · `packages/daemon` (HTTP/WS API, watchers — see [docs/API.md](docs/API.md)) · `packages/adapter-claude` / `packages/adapter-opencode` (ingestion + conversation-restore per CLI) · `packages/web` (React Flow graph UI) · `packages/cli` (`soj`). Design spec: [SOJOURN_BUILD_PLAN_V1.md](SOJOURN_BUILD_PLAN_V1.md).

```bash
npm test          # vitest across all packages
npm run build     # tsc -b + vite build
```
