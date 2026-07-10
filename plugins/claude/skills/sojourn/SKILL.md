---
name: sojourn
description: Use when the user asks about Sojourn, session history, agent-decision flags ("did the agent lie/guess?", "any flags?"), rewinding/restoring to an earlier point in an agent session, or marking decisions/checkpoints. Drives the local `soj` CLI and Sojourn daemon (decision graph + whole-tree snapshots + confidence flags + restore-to-worktree).
---

# Driving Sojourn from Claude Code

Sojourn is a local daemon that records agent sessions (this one included) into a decision graph with whole-working-tree snapshots, flags nodes where the agent's claims don't match ground truth, and restores any node into a fresh worktree. Full user guide: `docs/USAGE.md` in the Sojourn repo; HTTP API: `docs/API.md`.

## Preflight

Check the daemon before anything else: `soj status`. If unreachable, offer `soj start` (never start it silently mid-conversation without telling the user). If `soj` is not on PATH, use `node <sojourn-repo>/packages/cli/dist/main.js …`.

## What you can do

| User intent | Command |
|---|---|
| "What projects/sessions has Sojourn captured?" | `soj projects` |
| "Any flags? Did the agent get something wrong?" | `soj flags` (cwd's project) or `soj flags --project <id>`; `--all` includes auto-resolved |
| "Mark this as a decision / assumption" | `soj mark "<label>" --kind decision\|assumption` |
| "Checkpoint here" | `soj checkpoint "<name>"` |
| "What would restoring node X do?" | `soj restore <nodeId>` (preflight only — safe, changes nothing, exits 1 by design) |
| "Rewind/restore to node X" | `soj restore <nodeId> --yes` — ONLY after the user has seen the preflight warnings and confirmed |
| "Run the deeper LLM review on node X" | `soj critic <nodeId>` (requires ANTHROPIC_API_KEY on the daemon) |
| "Open the graph UI" | `soj open` |

Node ids come from `soj flags` output or the web UI inspector and look like `claude:<uuid>` — quote them in shell commands.

## Honesty rules (non-negotiable)

1. **Never present an advisory flag as verified.** `tier: verified` = deterministic ground-truth check, trustworthy. `tier: advisory` = LLM critic output — always relay it hedged ("possible", "worth checking"), never as a verdict.
2. **Always relay flag evidence verbatim** — the evidence string names the claim and the ground truth; that's the user's basis for judging it.
3. **A clean node is not proof of correctness** — say so if the user asks "is this session clean?".
4. **Restores are explicit.** Run the no-`--yes` preflight first, show the user the full warning list (Bash side effects, DB migrations, network calls, git pushes are NOT undone), and only run `--yes` after they confirm. The restore lands in a NEW worktree under `~/.sojourn/worktrees/` — the user's working tree and `.git` are never touched, and a safety snapshot is always taken first.
5. **Tip-resume caveat:** the printed resume command (`claude --resume <session> --fork-session`) forks the conversation from the session's tip; only the *filesystem* in the worktree is at the chosen node. Mention this when handing over the resume command.

## Environment knobs (daemon side)

`SOJOURN_HOME` (state dir, default `~/.sojourn`) · `SOJOURN_PORT` (default 4177) · `CLAUDE_CONFIG_DIR` (transcript watch root) · `ANTHROPIC_API_KEY` + `SOJOURN_CRITIC_MODEL` (T2 critic) · `OPENCODE_URL` / `SOJOURN_OPENCODE=1` (OpenCode capture).
