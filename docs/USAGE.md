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

soj restore <nodeId>             PREFLIGHT ONLY: prints the full side-effect warning list
                                 (including whether the snapshot is missing/thinned) and the
                                 resume command — then exits 1 without touching anything.
soj restore <nodeId> --yes       Actually restore: safety snapshot → new worktree → prints the
                                 worktree path and resume command.

soj harvest [worktreePath] [--yes] [--mode apply|patch] [--allow-conflicts]
                                 Restore's inverse: carry a restored worktree's changes back to
                                 the mainline project. Run it from inside the worktree, or pass
                                 the path. PREFLIGHT ONLY without --yes: prints every changed
                                 file as clean/conflict/identical plus whether the mainline moved
                                 on the paths this harvest touches, then exits 1 having written
                                 nothing. --yes performs it (mainline safety snapshot first,
                                 always, in every mode). --mode patch writes a
                                 .sojourn-harvest.patch inside the worktree and never touches the
                                 mainline. --allow-conflicts (apply mode only — it is rejected
                                 with --mode patch rather than silently ignored) writes conflict
                                 markers instead of aborting the whole apply. Exit 1 = stopped
                                 before writing anything (preflight, bad flags, any 400, daemon
                                 unreachable); exit 2 = the mainline WAS partially written
                                 (partial_apply / mainline_drift) and the applied/conflicted/
                                 remaining/safety-snapshot dump is on stderr. See §7.

soj combine <nodeIdA> <nodeIdB> [--yes] [--allow-conflicts]
                                 Merge the FILE STATES of two nodes — usually from DIFFERENT
                                 sessions — into ONE new worktree, three-way merged against their
                                 nearest common ancestor. NO TRANSCRIPT IS SYNTHESIZED: combine
                                 emits files only; start a genuinely fresh session in the output
                                 worktree. PREFLIGHT ONLY without --yes: prints both node ids, the
                                 resolved merge base, all three tree hashes, every path as
                                 clean/conflict/identical (conflicts that can never take markers
                                 are shown as "conflict (unmarkable)") and the warnings, then
                                 exits 1 having written nothing anywhere — not even into the
                                 shadow repo. --yes performs it. --allow-conflicts writes conflict
                                 markers instead of aborting. Node A is "ours": its tree is the
                                 starting content and the combine node is parented to it; node B
                                 is recorded as provenance in meta.mergedFrom. Exit 1 = stopped
                                 before writing anything (preflight, local validation, any 400,
                                 daemon unreachable); exit 2 = write_failed, where a half-built
                                 worktree WAS left on disk (deliberately not deleted) and the
                                 partial dump is on stderr. See §7.

soj gc [--project <id>] [--days N] [--archive-dir <path>] [--run]
                                 Prune old snapshot history in a project's shadow repo. Dry-run by
                                 default (prints what WOULD be pruned/reclaimed); pass --run to
                                 actually prune. Operates directly on $SOJOURN_HOME — the daemon
                                 does not need to be running. Never prunes a snapshot pinned by a
                                 decision/assumption/checkpoint node, a flagged node, or a live
                                 restored worktree (its .sojourn-restore.json is scanned
                                 automatically). If a live daemon lands a new snapshot mid-run, gc
                                 detects it and aborts safely without pruning anything — re-run
                                 soj gc later to complete it. The same run also sweeps synthesized
                                 rewind transcripts under the same cutoff and the same --run gate;
                                 native Claude session transcripts are never touched. See §8.

soj why "<query>" [--project <id>] [--file <path>]
                                 Full-text search over prompts, gists, marks, and annotations —
                                 "why/when did the agent do X?" Hits print best-first with kind,
                                 node id, gist, active-flag markers, and a snippet. See §9.

soj decisions [--project <id>] [--file <path>]
                                 The durable record: marked decisions/assumptions/checkpoints, plus
                                 any turn still carrying an active flag (evidence attached). See §9.

soj gate [--session <id> | --project <id>] [--include-advisory]
                                 CI-style check. Exit 0 = clean; 2 = active verified flags exist
                                 (prints an evidence table); 3 = daemon unreachable. Advisory flags
                                 never gate unless --include-advisory. See §10.

soj mcp                          Run a read-only MCP stdio server over the graph for agentic CLIs
                                 (sojourn_search, sojourn_decisions, sojourn_flags, sojourn_node).
                                 See §11.
```

Node ids come from `soj flags` output or the web UI inspector. They contain a `:`— quote them if your shell cares.

## 4. The web UI

`soj open` → `http://localhost:4177` (served by the daemon from `packages/web/dist`). Two views, switchable in the toolbar:

- **Map view (default) — the expedition map.** Each session is a dotted trail (newest session first, trail ink darkening toward the present); each **waypoint is one turn** (your prompt plus everything the agent did for it), sized by how much work happened, wearing a **work ring** — a thin donut showing the turn's composition (tool calls / assistant / other) — and folding serpentine when a session runs long. Verified flags appear as red hazard badges, advisory as amber outlines, decisions/checkpoints as pennants, and the newest turn carries the "you are here" pin. Clicking a waypoint opens a drawer with the turn's steps as chips — click a chip to inspect that node. A **minimap** (bottom-right) shows the whole atlas with a live viewport rectangle — click it to jump. Turn grouping is chronological, so it stays readable even when parent links are missing. Light/dark theme toggle lives in the toolbar (defaults to your OS preference).
- **Graph view — the node tree.** The raw left→right d3 tree (every prompt/tool/result node): parallel tool calls stack vertically, and hovering/selecting a node lights its entire lineage back to the root while everything else recedes. The Inspector mirrors that lineage as a clickable **Path** breadcrumb.
- **Search** (both views) — matches node gists, labels, kinds, tool names, and ids as you type; non-matches dim, a counter shows `n / total`, and Enter / Shift+Enter (or ‹ ›) cycles matches, panning the viewport to each (in map view it cycles matching turns). Esc clears.
- **Flag badges** — a **solid red badge with a count** means verified flags; a **muted amber outline badge** means advisory. They are deliberately impossible to confuse. Auto-resolved flags leave the badge counts.
- **Toolbar** — project selector, **decision lens** (collapse the graph to decision/assumption/checkpoint *and flagged* nodes — the "how did we get here, and where did it guess?" view), and a flagged-only filter.
- **Inspector** (click a node) — summary, raw payload, **on-demand file diff** for that node's step, annotations (add free-text notes), and every flag with its evidence. Dismiss buttons remember your dismissals. A **"Run advisory critic"** button triggers the T2 pass for that node.
- **Restore buttons** — *"Restore at this node"* (the node's own snapshot) and, from a flag, *"Restore to before this node"* (the parent's snapshot — i.e. just before the flagged step). Both show a modal with the daemon's warning list verbatim; nothing happens until you confirm.
- **Harvest** — a restore's result block grows a *"Harvest changes into project"* button (the worktree path is only known from that restore's own result, which is why harvest lives here and not on arbitrary nodes). It runs the preflight and shows a confirm modal: every changed file with its `clean` / `conflict` / `identical` status, a warning when your project has itself moved on files the harvest would touch, an apply-vs-patch choice, and — only when there actually are conflicts — an explicit "harvest anyway with N conflict(s)" checkbox. Confirm is disabled until you tick it, mirroring the server's own refusal. The worktree is re-read on confirm, and the path harvested is the one you reviewed, never a path that changed underneath you. A mid-apply failure renders the full partial-state report (applied / conflicted / remaining / safety snapshot) rather than a bare error.
- **Mark for combine → Combine with marked node** — combine is a deliberate two-step pairing, because its whole point is joining nodes from two *different* sessions. **Mark for combine** in one node's Inspector raises a persistent banner naming what is marked, with a **Clear** button; that mark survives changing the selection **and** changing the session filter, which is what makes it possible to go find the second node at all (dismissing the banner *is* un-marking — there is no invisible-but-armed state). Then open any other node and press **Combine with marked node**: the inspected node is A, the marked node is B. A confirm modal shows both ids, the resolved merge base, the per-file `clean` / `conflict` / `identical` table, the preflight warnings, and — prominently — the notice that combine merges **files only** and never the conversation. An "allow conflicts" opt-in appears only when there actually are conflicts, mirroring the server's own refusal. On success you get the output worktree path; on a `write_failed` you get the full partial-state report (worktree, applied, conflicted, remaining) rather than a bare error. See §7.
- **Session filter banner** — once you've made an explicit session selection, a banner appears when new sessions are being hidden by it ("N new sessions aren't shown"), with *Show them* and a dismiss ×. It never appears on the default path, where the newest session is shown automatically.

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

**Conversation restore — two modes.** For Claude Code sessions, every restore also attempts an **exact-node rewind**: the daemon synthesizes a brand-new transcript file containing only the chain of lines from the root to the node you chose (the original transcript is never touched), and the resume command becomes `claude --resume <newSessionId>` — the resumed *conversation* genuinely starts at that node, not just the session's tip. Sojourn refuses exact rewind, honestly and by design, whenever it can't guarantee the reconstruction is correct — an incomplete ancestor chain (orphaned parentage), a parentage cycle, or a chain that crosses a compaction/summary boundary (Claude Code compacted the conversation, so the exact prior turns no longer exist to replay) all refuse, with a `refusedReason` explaining why. A refusal — or an OpenCode session, which restores in tip mode only — falls back to the **tip-mode** resume command you'd get in V1: `claude --resume <sessionId> --fork-session`, which continues the conversation from wherever the session currently stands, while the *filesystem* in the worktree is still restored exactly to the node you chose. A rewind failure never fails the restore itself — the `rewind` field is simply omitted from the response and you still get a working tip-mode resume command.

## 7. Harvest and combine — bringing worktree work back

A restore drops you into a **new, disposable worktree**, deliberately isolated from your mainline project so nothing you do there touches real state by accident. When work in that worktree turns out to be worth keeping, **harvest** merges it back into your mainline project root — the first (and only) Sojourn feature that ever writes into your actual project directory.

Three surfaces, one engine: the `soj harvest` CLI, the web UI's Inspector button on a restore result (§4), and the HTTP routes (`docs/API.md`) if you'd rather script it.

```bash
cd ~/.sojourn/worktrees/<projectId>/<worktree>
soj harvest                          # PREFLIGHT ONLY — classifies every changed file,
                                     # writes nothing, exits 1
soj harvest --yes                    # apply: mainline safety snapshot, then write
soj harvest --yes --mode patch       # write .sojourn-harvest.patch in the worktree instead
soj harvest --yes --allow-conflicts  # apply mode only: conflict markers instead of an abort

soj harvest /path/to/worktree        # or name the worktree instead of standing in it
```

The path is resolved locally before it is sent, so a relative path (including the default `.`) works. `--allow-conflicts` together with `--mode patch` is **rejected locally** rather than accepted and ignored: a patch never writes conflict markers into your mainline, and a flag that looks accepted but does nothing is a lie.

A typical harvest, in order:

1. **Preflight** (`soj harvest` with no `--yes`, or `POST /api/worktrees/harvest/preflight {worktreePath}`) — a dry run that never writes to your mainline. Reads the worktree's `.sojourn-restore.json` manifest to resolve the origin project (mainline root + the shared shadow git repo the worktree branched from) and classifies every changed file as `clean` (safe to apply), `conflict` (both sides touched it since the branch point), or `identical`. No manifest, or it doesn't resolve → `code: "no_manifest"`; a base tree that has aged out of the shadow repo → `stale_base`; an unreadable worktree file → `read_failed`. (Preflight does take a snapshot of the *worktree* into the shadow repo in order to diff it — "no writes" here means no writes to your mainline project, which is the part that matters.)
2. **Harvest** (`soj harvest --yes`, or `POST /api/worktrees/harvest {worktreePath, mode}`) — internally: **mainline safety snapshot first, unconditionally, before anything else, in EVERY mode** (same non-negotiable guarantee as restore — even `patch` mode takes one, despite never writing to the mainline itself), then classification is re-run, then:
   - `mode: "apply"` — writes the worktree's clean changes onto the mainline. Any conflict aborts the **whole** apply cleanly (nothing written) unless you pass `allowConflicts: true`, in which case clean files land and conflicting ones are named in the response. A successful apply that lands at least one file gets a **checkpoint node** in the graph, parented to the restore's origin node — the worktree session joins the origin project's graph instead of living in a disconnected branch.
   - `mode: "patch"` — composes a `base..branch` patch file (`.sojourn-harvest.patch`) inside the worktree and never touches the mainline, for when you'd rather review and apply by hand.

**Conflict and failure handling is honest, not silent.** A mid-apply failure (e.g. a read-only destination) never leaves a half-applied mainline pretending to be a success — it aborts with a typed error naming exactly what applied, what conflicted, and what's left (a `.partial` payload), with the mainline safety snapshot always there as the fallback. Typed error codes: `no_manifest`, `stale_base`, `conflicts`, `patch_incomplete`, `read_failed` (400s — **all of them abort-clean, with nothing written to the mainline**); `partial_apply`, `mainline_drift` (500s, `.partial` in the body). `read_failed` is a 400 even though the apply path can raise it too: both sites wrap the same dry classification pass over temp files, so it always stops before any mainline write. `mainline_drift` fires when the mainline itself changed underneath the harvest between classification and write — nothing further is written once that's detected.

`soj harvest` makes that distinction scriptable, because it is the distinction that matters at 2am:

| Exit | Meaning |
|---|---|
| `0` | Harvest completed (or the patch was written) |
| `1` | Stopped **before** writing anything — the default preflight, a bad flag combination, any typed 400, or an unreachable daemon |
| `2` | **The mainline was partially written** — `partial_apply` or `mainline_drift`. The full applied / conflicted / remaining / safety-snapshot state is dumped to stderr; the safety snapshot named there is your pre-harvest tree |

A script can never mistake "we stopped before touching anything" for "your project is now half-harvested."

**Known limits (documented, not hidden):** harvest transfers file *contents* only — file-mode changes (e.g. the executable bit) aren't preserved; a branch entry that is itself a symlink is materialized as a regular file containing the target path; patch mode emits git's ordinary "Binary files differ" stub for binary paths rather than a binary-aware patch.

### `soj combine` — merging two sessions' file states

Harvest carries **one** worktree back to the mainline. **Combine** answers the other question: two sessions branched from the same point, both did work worth keeping, and you want one tree that has both.

```bash
soj combine <nodeIdA> <nodeIdB>                        # PREFLIGHT ONLY — exits 1, writes nothing
soj combine <nodeIdA> <nodeIdB> --yes                  # combine into a NEW worktree
soj combine <nodeIdA> <nodeIdB> --yes --allow-conflicts   # conflict markers instead of an abort
```

> **Combine emits FILES ONLY. No conversation transcript is ever synthesized, in any mode.**
>
> This is a deliberate boundary, not a missing feature. Neither original session is continued: interleaving two real conversations into a third would mean inventing turns that never happened, and Sojourn refuses to guess where it cannot reconstruct faithfully (the same rule that makes exact rewind refuse across a compaction boundary — §6). What you get is a worktree. You start a genuinely **fresh** session in it, and Sojourn's existing worktree aliasing links that session to node A automatically, so it still joins the project's graph. If you were expecting a merged conversation, this feature does not do that and never will.

The mechanics, in order:

1. **Resolve the merge base.** Combine walks both nodes' ancestor chains and takes the **nearest common ancestor**, resolving every side's tree through the same shared `findEffectiveTree` that restore and GC's pinning use. No common ancestor → `no_common_ancestor`, refused: there is no shared state to merge against, and picking an arbitrary base would be a guess. Both nodes must also belong to the **same project**, so that base, A and B all live in one shadow object database → otherwise `cross_project`.
2. **Classify** every path that node B moved since the base, three-way against node A, using the exact same `clean` / `conflict` / `identical` vocabulary as harvest. Paths only A touched are already correct in A's tree and need no work. The whole pass is a dry run over temp files — `git merge-file -p` against `os.tmpdir()` scratch, never git plumbing against your repo.
3. **Materialize.** Node A's tree is checked out into a **new** worktree under `~/.sojourn/worktrees/<projectId>/combine-…`, then node B's side is merged on top. Nothing outside that new directory is ever written: not your project, not its `.git`, not either source worktree, not either source snapshot.
4. **Record it.** A combine that lands at least one file inserts a **`checkpoint` node** whose `parentId` is node A and whose `meta.mergedFrom` is node B (schema migration **V4** added the backing `nodes.merged_from` column). **The graph stays a tree** — `parentId` is still single and Sojourn is not a DAG; the second ancestor is provenance, not structure. `combineNodeId: null` in the response is a legitimate outcome, **not** an error: it means no store was reachable, the combine wrote zero files (an all-identical combine is not a merge), or the origin node was unknown.

Preflight is the purest of Sojourn's three preflights. `restore`'s validates a tree, `harvest`'s snapshots the live worktree into the shadow repo — combine's writes **nothing anywhere**, because base, A and B are all pre-existing trees. It is safe to run as often as you like.

**`unmarkable` is not a synonym for `conflicted`, and the CLI prints them as separate blocks.** A `conflicted` file was written **with** conflict markers, so both sides are visible in it. An `unmarkable` file is a conflict that could never take text markers (binary content on some side), so node A's content was kept verbatim and **node B's side is not present in the output worktree at all**. Unmarkable paths appear in *both* lists — they are conflicts; the extra list is what tells you which of them silently kept A. Collapsing the two would misreport what is actually on disk.

**Failures are typed, and the abort-clean line is sharp.** Every code except one is raised *before* the output directory is even claimed, so it is provably zero-write:

| Code | HTTP | Meaning |
|---|---|---|
| *(none)* | 400 | Body validation: a missing/blank `nodeIdA`/`nodeIdB`, or the two ids being equal. Never reaches the engine, so there is no `code` field |
| `not_found` | 400 | One of the node ids (or its project) is unknown to the store |
| `cross_project` | 400 | The two nodes belong to different projects |
| `no_common_ancestor` | 400 | The chains never meet — no shared state to merge against |
| `no_tree` | 400 | A side has no effective snapshot tree, or its tree is gone from the shadow repo |
| `conflicts` | 400 | Conflicted files and no `--allow-conflicts`. No worktree was created |
| `read_failed` | 400 | A path could not be read out of the base/A/B snapshots. A failed read is never silently treated as "that side deleted the file" |
| `dest_exhausted` | 400 | A unique output worktree directory could not be claimed |
| `write_failed` | **500** | **The only partial state.** A half-built worktree exists on disk |

`write_failed` is deliberately different in every way. It is the only 500, the only code that leaves anything behind, and the worktree it names is **not deleted** — it holds real merged content, and deleting it would turn combine into a source of data loss. Its body carries `partial: { worktreePath, applied, conflicted, remaining }`, and `soj combine` exits **2** and dumps that whole state to stderr:

| Exit | Meaning |
|---|---|
| `0` | Combine completed |
| `1` | Stopped **before** writing anything — the default preflight, local validation (`nodeIdA === nodeIdB`), any typed 400, or an unreachable daemon |
| `2` | **`write_failed`** — a half-built worktree exists and was left in place. Inspect it before re-running; nothing else was touched |

A script can never mistake "we stopped before touching anything" for "a partly-merged worktree is sitting on your disk." Routes and response shapes: [API.md](API.md). A real cross-session combine, captured end to end — including the assertion that no transcript appeared — is [DEMO.md §12](DEMO.md).

**Known limits:** the same contents-only caveats as harvest apply (no file modes, symlinks materialized as regular files containing the target path). Combine also never writes to your mainline project at all, in any mode — if you want the merged result in your project, harvest the combine worktree afterwards.

## 8. Retention & garbage collection (`soj gc`)

Every node boundary writes a new whole-tree snapshot into the project's shadow repo — over a long-lived project that adds up. `soj gc` prunes old snapshot history without ever touching your project's real `.git`, and without ever pruning something you might still need:

```bash
soj gc                                    # dry-run preview for cwd's project, 30-day keep window
soj gc --days 14                          # preview with a shorter keep window
soj gc --archive-dir ~/sojourn-archive    # preview + (on --run) write a backup bundle first
soj gc --run                              # actually prune
```

**What's always kept**, regardless of age: anything younger than `--days` (default 30); every snapshot for a `decision` / `assumption` / `checkpoint` node; every snapshot for a node carrying **any** flag, dismissed or not, verified or advisory (evidence worth being able to re-examine later); and the tree hash of every live restored worktree, read automatically out of its `.sojourn-restore.json` manifest so `soj gc` never prunes a snapshot a worktree you're actively using still depends on. The safety-snapshot history gc itself relies on (`refs/sojourn/safety`) is never pruned either — restoring is never made less safe by running gc.

**Dry-run is the default on purpose.** Without `--run`, `soj gc` computes and prints exactly what it would do — kept/pruned commit counts and a reclaim-size estimate — without deleting anything. Nothing is mutated until you pass `--run`.

**Concurrency: abort and retry, not a race.** `soj gc` does not need the daemon stopped — it's safe to run while capture is active. If a live daemon lands a new snapshot in the exact window gc is finalizing, gc detects the conflicting write (a compare-and-swap on the shadow repo's head ref) and **aborts the entire run before pruning anything**: the concurrent snapshot is untouched, nothing is lost, and gc prints that it aborted and to re-run it later to complete the job. This is intentionally an abort-and-retry design rather than a lock — gc never blocks capture, and capture never has to wait on gc.

**Synthesized rewind transcripts are swept too.** An exact-node rewind (§6) writes a brand-new transcript file next to your Claude Code sessions, plus a small Sojourn sidecar recording which session and node it came from. The same `soj gc` run also ages those out, under the *same* `--days` cutoff and the *same* dry-run-unless-`--run` gate, and reports them on their own `transcripts` line (kept / swept, plus reclaimed bytes). Only sidecars whose recorded origin session belongs to this project are considered. Retention mirrors the snapshot rule exactly: a rewind transcript whose origin node is a `decision` / `assumption` / `checkpoint`, or carries any flag, is kept regardless of age.

> **Your real session history is never touched.** A `.jsonl` with no Sojourn sidecar is the ordinary shape of every *native* Claude Code session, and the sweep treats that shape as untouchable — as it does any sidecar it cannot parse. Only a transcript paired with a sidecar Sojourn wrote, or an inert sidecar left with no transcript, is ever a candidate. Deletion goes sidecar-first, on purpose: an interrupted delete can only leave an inert orphan sidecar (which the next sweep cleans up), never an unattributed transcript that would ingest as a phantom session. That is the same ordering restore/rewind uses when it *writes* the pair.

`--archive-dir <path>` writes a full `git bundle` of everything about to be touched (not just the pruned range) before any ref is rewritten or object pruned, so a classification bug can never make the backup itself incomplete.

## 9. Decision memory (`soj why` / `soj decisions` / `/api/search`)

Sojourn indexes prompts, gists, marks, and annotations into a full-text search index as they're captured, plus a files-touched index per node, so you can ask "why did we do X" months later instead of scrolling the graph.

```bash
soj why "why sqlite over postgres"        # full-text search, best match first
soj why "auth flow" --file src/auth.ts    # only turns that touched this file
soj decisions                             # marked decisions/assumptions/checkpoints + flagged turns
soj decisions --file src/auth.ts          # same, filtered to a file
```

`soj why` hits print `[kind] node-id  gist` with active-flag markers and a snippet, in the same best-first order the daemon returns (bm25-ranked). A query with no hits gets a two-line nudge toward `soj decisions` rather than a bare "nothing found."

`soj decisions` is the durable record — marks plus any node still carrying an active (non-dismissed, non-auto-resolved) flag — with each flag line printed as `⚑ kind (tier/confidence): evidence` so an advisory flag can never be mistaken for a verified one, even in this listing.

Both are thin CLI wrappers over `GET /api/search?projectId=&q=&file=&kinds=` (docs/API.md) — script against that route directly for anything more custom. Query text is always treated as literal phrases (never parsed as FTS operators), so search terms containing `OR`, `NOT`, quotes, or other special characters can't throw or over-match.

## 10. `soj gate` — CI-style verification

`soj gate` turns Sojourn's verified flags into a pass/fail check you can wire into CI or a pre-merge hook:

```bash
soj gate                                  # gate cwd's project's whole graph
soj gate --session <id>                   # gate one session (turns/flags from its health route)
soj gate --include-advisory               # also gate on hedged LLM-critic flags
```

Every run prints the same honest header first, on every outcome: `checked: claims vs snapshots recorded by the local Sojourn daemon` — the gate proves recorded claims against snapshots, nothing more; it is not a general correctness proof.

Exit codes:

| Exit | Meaning |
|---|---|
| `0` | Clean — `gate passed: N turns, 0 active verified flags` |
| `2` | Active verified flags exist — prints a table (node, kind, tier, confidence, evidence excerpt) |
| `3` | Daemon unreachable — distinct from both pass and fail on purpose: "could not check" is never reported as "passed" |

Advisory flags never gate by default — a note names any active advisory count and points at `--include-advisory`. With that flag set, advisory flags gate too and appear in the table with tier `advisory`, still clearly labeled as such.

## 11. `soj mcp` — MCP server for agentic CLIs

`soj mcp` runs a local, **read-only** [MCP](https://modelcontextprotocol.io) stdio server so any agentic CLI (not just Claude Code) can query the decision graph itself mid-session, instead of you copy-pasting flag evidence into the conversation.

```bash
claude mcp add sojourn -- soj mcp
```

Four tools, every one backed by the daemon HTTP API (never the database directly), all read-only:

| Tool | Arguments | Returns |
|---|---|---|
| `sojourn_search` | `query`, `file?`, `project?` | relevance-ordered hits (gist + snippet + active flag kinds) |
| `sojourn_decisions` | `project?` | marks (decision/assumption/checkpoint) + actively flagged turns |
| `sojourn_flags` | `sessionId?` | active flags with tier/confidence/evidence |
| `sojourn_node` | `nodeId` | one full node including flags and annotations |

If the daemon is down, tools answer with friendly guidance text ("not reachable … `soj start`") rather than a protocol error, and the server keeps answering other requests normally. The default project is derived from the working directory `soj mcp` was launched in.

## 12. Claude Code integration

The pull-based transcript watcher is the **source of truth** — Sojourn works with zero Claude Code configuration. The plugin in `plugins/claude/` adds two optional things on top:

1. **Push-timing hooks** (`SessionStart` / `PostToolUse` / `Stop`) that ping the daemon so ingestion is immediate instead of debounce-delayed. The hook script always exits 0 within ~3.5 seconds, daemon up or not — it can never break your session.
2. **The `sojourn` skill** (`plugins/claude/skills/sojourn/`) that teaches Claude Code itself how to drive `soj` — so you can ask Claude "any flags on this session?" or "rewind to before that bad refactor" and it knows what to do.

### Installing the plugin

The plugin is a **self-contained bundle** — it does not assume you're working inside a Sojourn repo checkout. There are two install modes:

**In-repo dev checkout** — you have (or are working in) a full clone of the `sojourn` repo:

```bash
git clone <this-repo> sojourn
cd sojourn
npm install
npm run build            # tsc for all packages + web + build:plugin (regenerates the hook bundle)
claude plugin install /path/to/sojourn/plugins/claude   # or add via /plugin in Claude Code
```

`npm run build` (or the narrower `npm run build:plugin`) keeps `plugins/claude/hooks/sojourn-hook.mjs` — a generated, dependency-free ESM bundle of `packages/adapter-claude/src/hooks/postToolUse.ts` — in sync with the TypeScript source.

**Copied plugin directory** — you only have `plugins/claude/` itself, e.g. copied out of a release archive or a marketplace entry, with no `packages/` or `node_modules/` alongside it:

```bash
cp -r plugins/claude ~/wherever/sojourn-claude-plugin
claude plugin install ~/wherever/sojourn-claude-plugin
```

This works out of the box with **no `npm install` and no build step** — `hooks/sojourn-hook.mjs` is already a finished artifact with zero runtime imports outside Node builtins. What you can't do from a copied directory is regenerate that bundle; to pick up hook changes, re-copy an updated `plugins/claude/` from a repo checkout that has rebuilt it (`npm run validate:plugin` verifies the bundle stays self-contained and `hooks.json` never resolves outside the plugin directory).

Either way, a running Sojourn daemon (`soj start`) is what actually records anything — the plugin only forwards events to it.

### Terminal flag delivery (`SOJOURN_HOOK_FLAGS=1`)

By default the hooks are silent — they POST the event and exit, printing nothing. Set `SOJOURN_HOOK_FLAGS=1` in the environment Claude Code itself runs in (e.g. `export SOJOURN_HOOK_FLAGS=1` before launching `claude`) to additionally have the `Stop` hook print that turn's active flags straight to your terminal:

```
Sojourn: edit_claim_mismatch — claimed src/x.ts:42 edited, snapshot shows no change
```

This surface is **verified-only, by contract and by a second guard**: the underlying route only ever returns active verified flags, and the hook itself drops any line that mentions "advisory" as defense in depth — an unverified guess can never read as confirmed here. Output is budgeted (max 3 lines plus a `"+n more"` marker on overflow, digest-collapsed) so a flag storm can't flood your terminal. It only fires on `Stop`, and only when the daemon responds within its own short timeout — a slow or unreachable daemon means no lines print, the same silent-and-exit-0 behavior as when the variable is unset. This is purely additive: it never changes the hook's exit code (always 0) or blocks the session either way.

#### Timing: what you see is usually the *previous* turn's state

This surface is fast, not settled, and the difference is worth understanding before you trust it.

The `Stop` hook does two things in one run: it POSTs the event that **triggers** the daemon's re-scan of the transcript, and then it GETs `/api/sessions/:id/turn-flags` to print. That GET has its own 500ms budget (`FLAGS_TIMEOUT_MS`), separate from and in addition to the 500ms POST budget, both sitting inside the hook's 3500ms hard exit. The daemon answers the GET straight out of the nodes it has **already ingested** — there is no wait-for-ingest anywhere in that route. So within 500ms you will usually be reading the session as it stood *before* the turn that just ended.

This is not a bug to be tuned away; it is the direct consequence of the rule that **capture never blocks**. The hook will never stall your session waiting on ingestion, so it can only ever print what's ready.

What that means in practice:

- The lines you see typically reflect the state **before** the turn that just finished. A flag raised by the turn you just watched will usually show up on the *next* one.
- **Silence is not a clean bill of health.** No lines can mean no flags, or a daemon that was slow, down, or simply hadn't ingested the turn yet — the hook cannot tell you which, and by design won't wait to find out.
- For the settled picture, run `soj flags` or refresh the web UI. Those read the graph after ingestion, with no timeout racing them.

Treat terminal delivery as a cheap nudge that costs your session nothing, and `soj flags` / the UI as the answer.

## 13. OpenCode integration

`POST /api/hooks/opencode {sessionId}` makes the daemon pull that session's messages from the local OpenCode server (`OPENCODE_URL`, default `http://localhost:4096`) and ingest them into the same per-project graph — Claude and OpenCode nodes unify by repository. `plugins/opencode/sojourn.ts` forwards session events to that route. Set `SOJOURN_OPENCODE=1` to have the daemon also subscribe to OpenCode's `/event` SSE stream directly (off by default).

**Honesty note:** the OpenCode adapter was written against OpenCode's documented API and is **not yet live-integration-tested**; every module carries that header, and everything fails soft (an unreachable OpenCode server is logged and ignored).

## 14. Environment variables

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
| `SOJOURN_HOOK_FLAGS` | off | `1` = the Claude Code `Stop` hook prints active verified flags to the terminal. Set in the environment Claude Code itself runs in, not the daemon's. Note it shows the **previous** turn's state, and silence is not proof of a clean turn — see §12. |

## 15. HTTP & WebSocket API

The daemon exposes a full local API (projects, graph, node diffs, flags/run, preflight/restore, annotations, mark, dismiss, hooks, search, session health, turn-flags, rewind, harvest) plus `node_added` / `flags_updated` / `project_updated` WebSocket events — see [docs/API.md](API.md) for the route table and payload shapes. Everything the CLI and web UI do goes through this API, so you can script against it.

## 16. Troubleshooting

- **`soj` not found** — run `npm link -w @sojourn/cli`, or call `node packages/cli/dist/main.js …` directly.
- **"daemon is not reachable … Try `soj start`"** — the daemon isn't running (or is on a different `SOJOURN_PORT`).
- **No projects appear** — the watcher only sees sessions under `CLAUDE_CONFIG_DIR`; check `soj status`, then look at the daemon log output. Snapshots additionally require the project root to still exist on disk.
- **A node shows no diff / flags stay silent** — expected when that step has no snapshot ground truth (e.g. the very first turn); precision over recall means silence, not guessing.
- **Hook printed no flags / the wrong turn's flags** — expected, and inherent to the design. The `Stop` hook asks the daemon for flags 500ms after triggering the re-scan and never waits for ingestion, so it usually prints the state as of *before* the turn that just ended, and prints nothing at all if the daemon was slow, down, or not caught up. Do not read that silence as "this turn was clean." Run `soj flags` (or refresh the web UI) for the settled answer. Full explanation in §12.
- **`soj critic` returns an error** — `ANTHROPIC_API_KEY` must be set in the environment of the *daemon* process, not your shell; restart it after setting.
- **Stale pidfile after a crash** — `soj start`/`soj stop` detect a recycled PID (process identity check) and clean up automatically; they will never signal a non-Sojourn process.
- **Restore refused, "snapshot missing or thinned by retention policy"** — the preflight found no valid snapshot for that node (or its ancestors), including the case where `soj gc` pruned it. Nothing was changed; pick a node that carries a snapshot (the UI shows diffs only on such nodes), or re-run without pruning it next time (pin it with a mark, or widen `--days`).
- **`soj gc` says it aborted** — a live daemon landed a new snapshot in the exact window gc was finalizing; by design gc pruned nothing and left everything as-is. Just re-run `soj gc` (with `--run` if you meant to prune).
- **`soj gate` exits 3** — the daemon is unreachable, deliberately distinct from exit 0 (pass) and exit 2 (fail): "could not check" is never reported as "clean."
- **Harvest refuses with `no_manifest`** — the path you gave isn't a Sojourn restore worktree (no readable `.sojourn-restore.json`), or its origin project can't be resolved. Harvest only ever operates on worktrees Sojourn itself created.
- **Harvest refuses with `stale_base`** — the base tree recorded in that worktree's `.sojourn-restore.json` is no longer in the shadow snapshot repo, so there's no branch point to diff against. Usually a `soj gc --run` that pruned it while the worktree wasn't live enough to pin it. Nothing was written; recover the work by hand (`git diff`, or copy the files) — and pin long-lived worktrees with a mark, or widen `--days`, next time.
- **Harvest refuses with `read_failed`** — a file in the worktree couldn't be read (permissions, or the worktree moved/vanished mid-run). Like every harvest 400 this is abort-clean: **nothing was written to your project**, even though the apply path can raise it, because it happens during the dry classification pass. Fix the permissions or confirm the worktree still exists, then re-run.
- **`soj harvest` exited 2** — this is the one that matters: `partial_apply` or `mainline_drift`, meaning your mainline **was** partially written before the failure. stderr lists exactly what applied, what conflicted, what's left, and the safety-snapshot ref taken before the harvest started. Inspect your working tree against that before re-running. Exit 1, by contrast, always means nothing was written.
- **`soj combine` refuses with `no_common_ancestor`** — the two nodes' ancestor chains never meet, usually because they are roots of unrelated sessions rather than two branches off a shared point. There is no shared state to merge against, so combine refuses instead of guessing a merge base. Nothing was written. Pick nodes that descend from a common ancestor (a restore or rewind of the same node is the usual way two sessions come to share one) — or, if you only want one side's files, use `soj restore` instead. `cross_project` is the same shape of refusal for nodes in two different projects.
- **`soj combine` reported files under "Unmarkable"** — those are conflicts that could not take text conflict markers (binary content on some side). Node A's content was kept verbatim, and **node B's version of those paths is not in the output worktree at all** — `--allow-conflicts` does not change that, it only affects files that *can* take markers. Retrieve B's side by hand if you need it (`soj restore` node B into its own worktree and copy the file).
- **`soj combine` exited 2** — `write_failed`: a half-built worktree exists on disk. It is deliberately **not** deleted, because it holds real merged content and removing it would lose work. stderr names the worktree and lists what was applied, what conflicted, and what remained unprocessed. Inspect that directory before re-running; nothing outside it was touched. Exit 1, by contrast, always means nothing was written anywhere.
- **The combined worktree has no conversation / `claude --resume` doesn't offer one** — working as intended. Combine emits **files only**; no transcript is synthesized and neither source session is continued. Start a fresh session with the combine worktree as your cwd — Sojourn's worktree aliasing links it back to node A on its own. See §7.
- **Everything broke, where's my data?** — the DB and snapshots live under `~/.sojourn`; your project tree and `.git` are never written to by capture, restore, or gc. Harvest is the one exception, and only after its own safety snapshot. Safety snapshots taken before every restore/harvest/gc are in the shadow repo (`refs/sojourn/head` and `refs/sojourn/safety` history).
