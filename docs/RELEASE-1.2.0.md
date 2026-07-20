# Sojourn v1.2.0 — Release Notes

**Status:** released. Published to npm as `@sojourn/*` and tagged `v1.2.0`.

```bash
npm i -g @sojourn/cli
```

**Requires:** Node ≥ 20. macOS and Linux. Local-only — the daemon binds
`127.0.0.1` and nothing leaves your machine.

v1.2.0 is the first release document for Sojourn. It covers the complete V1 + V2
feature set, the reliability hardening that followed, and the V2.1 backlog closed
on top of it. There is no prior published release to diff against, so this reads
as a full inventory rather than a delta.

---

## What Sojourn does

Sojourn records everything your agentic coding CLI does — every prompt, tool call,
decision, and assumption — into a persistent, cross-session **decision graph**, and
snapshots your **whole working tree** at every step into a shadow git repo that
never touches your `.git`. Deterministic **verified flags** catch nodes where the
agent's claims don't match reality. Any node can be **restored** — filesystem *and*
conversation — into a fresh worktree to branch from, and work done there can be
**harvested** back to mainline.

The core loop: *spot where the agent guessed or slipped → rewind to just before it
→ branch correctly.*

---

## Headline features

### Capture and navigation
- Passive, cross-session, cross-CLI decision graph; whole-working-tree shadow-git
  snapshots at every step, never touching your project's `.git`.
- Web UI (`soj open`): map view (turn waypoints sized by work, flag badges,
  decision pennants, minimap, search) and graph view (node tree with lineage
  highlighting and a path breadcrumb).
- Multi-select session filter, opening on the latest session only for speed on
  large histories. Hidden sessions are never laid out.
- Restore-point highlighting and a "Restorable" filter; nodes whose snapshot is
  gone are muted with restore disabled up front rather than after a dead-end click.
- Live WebSocket updates with automatic reconnect + refetch and a self-clearing
  "daemon unreachable" banner.

### Trust — verified vs advisory flags
- Five deterministic **verified** checks (edit-claim mismatch as flagship, package
  hallucination, symbol and file-ref grounding, test-claim verification), each with
  evidence, auto-resolve, and per-turn budgets/digests.
- An opt-in Tier-2 LLM critic that is structurally prevented from masquerading as
  verified.

### Restore, rewind, harvest and combine
- Whole-tree **restore** into an isolated worktree — safety snapshot first, your
  `.git` untouched.
- **Exact-node conversation rewind** for Claude Code, with honest refusal when the
  transcript cannot be faithfully reconstructed (compaction boundary, orphaned
  parentage). Refusing is always preferred over guessing.
- **Harvest** — the return path from a restore worktree back to mainline, available
  three ways: `soj harvest`, the web Inspector, and the HTTP API.
- **Combine** — three-way merges the **file states** of two nodes, typically from
  two different sessions, into one new worktree, recording both ancestors. Files
  only: no conversation transcript is ever synthesized, and the graph stays a
  tree. Available as `soj combine`, a two-step mark/combine flow in the web
  Inspector, and the HTTP API.

### Decision memory, gate and retention
- `soj why` / `soj decisions` full-text search plus a files-touched index.
- `soj mcp` — a read-only MCP server over the graph.
- `soj gate` — CI-style exit codes (0 clean / 2 active verified flags / 3 daemon
  unreachable).
- `soj gc` — pin-aware retention for snapshots *and* synthesized rewind
  transcripts, dry-run by default.

---

## New in v1.2.0

### Reliability hardening
The daemon is crash-proofed after a real field failure: a live daemon was dying
silently on an ~11k-step workload.

- **Root cause fixed:** the ingest flag phase was O(n²) in memory, OOM-killing a
  default-heap Node in about a minute with the V8 banner lost to discarded stderr.
  Now ~9s / ~300MB, guarded by a scale test that pins a 1.5GB RSS budget.
- **Rotating log** at `~/.sojourn/daemon.log`, with `soj start` / `soj status`
  surfacing the log tail instead of failing silently.
- **Process guards** that log and survive — one bad transcript can never take
  capture down — with a crash-storm breaker.
- The daemon binds **loopback only**; its write routes are unreachable from the
  network.

### Log rotation no longer loses crash forensics
Rotation used `rename`, but the CLI hands the detached daemon an `O_APPEND` file
descriptor, and an fd binds to the *inode*, not the path. After a first rotation,
logger lines and raw process output split across two files; after a second, the
rename unlinked the inode the child still held, so every subsequent byte of raw
stdout/stderr — including the V8 OOM banner, which never passes through the logger
— was written to a deleted file.

That is precisely the failure the rotating log existed to catch. Rotation is now
copy-then-truncate, which keeps the inode alive; `O_APPEND` recomputes the offset
per write, so truncation leaves no sparse gap.

### `soj combine` — merging two sessions' file states
Restore takes you back to one node. Harvest brings one worktree forward. Combine
answers the case neither covered: two sessions branched from the same point and
both did work worth keeping.

```bash
soj combine <nodeIdA> <nodeIdB>                          # preflight: merge base, per-file
                                                         # clean / conflict / identical, exits 1
soj combine <nodeIdA> <nodeIdB> --yes                    # combine into a NEW worktree
soj combine <nodeIdA> <nodeIdB> --yes --allow-conflicts  # markers instead of an abort
```

It three-way merges the two nodes' **file states** against their nearest common
ancestor — resolved through the same shared `findEffectiveTree` restore and GC's
pinning already use — and materializes the result into a new worktree under
`~/.sojourn/worktrees/`. Node A's tree is the starting content; node B is merged
on top. Nothing outside that new directory is ever written.

**It emits FILES ONLY. No conversation transcript is ever synthesized, in any
mode.** Neither source session is continued. Interleaving two real conversations
into a third would mean inventing turns that never happened, and this project
refuses to guess where it cannot reconstruct faithfully — the same rule that
makes exact rewind refuse across a compaction boundary. You start a genuinely
fresh session in the output worktree, and the existing worktree aliasing links it
back to node A on its own. The demo asserts this rather than asserting it in
prose: it lists every `.jsonl` in the watched directory before and after the
combine and requires the two lists to be identical.

**The graph stays a tree.** A combine that lands at least one file inserts a
`checkpoint` node whose `parentId` is node A and whose `meta.mergedFrom` is node
B — provenance, not a structural second parent. Migration **V4** adds the backing
`nodes.merged_from` column. Converting to a DAG was considered and rejected: it
would have forced new semantics on `findEffectiveTree`, GC's `collectPins`,
rewind's ancestor walk and the web layout simultaneously, for traceability that a
provenance column already provides. **Sojourn is not a DAG.**

Two static HTTP routes carry the node ids in the **body**, so nothing is
URL-encoded: `POST /api/nodes/combine/preflight` and `POST /api/nodes/combine`.
Their registration order is load-bearing — they are declared ahead of the whole
`/api/nodes/:id/...` family, because `/api/nodes/:id/preflight` would otherwise
capture `/api/nodes/combine/preflight` with `id="combine"` and route it to the
restore engine. An explicit shadowing test pins it.

Exit codes mirror `soj harvest`, with a sharper abort-clean line:

| Exit | Meaning |
|---|---|
| 0 | success |
| 1 | stopped *before* writing anything — preflight, local validation (`nodeIdA === nodeIdB`), every 400, daemon unreachable |
| 2 | `write_failed` — a half-built worktree **was** created; the full worktree / applied / conflicted / remaining dump goes to stderr |

Every typed code except `write_failed` (`not_found`, `cross_project`,
`no_common_ancestor`, `no_tree`, `conflicts`, `read_failed`, `dest_exhausted`) is
a 400 raised *before* the output directory is even claimed — provably zero bytes
written. `write_failed` is the only 500 and the only partial state, and the
worktree it names is deliberately **not** deleted: it holds real merged content,
and removing it would make combine a source of data loss.

Two result fields must not be collapsed into one another. `conflicted` files were
written **with** conflict markers; `unmarkable` files are conflicts that could not
take markers at all (binary content), so node A's content was kept verbatim and
**B's side is not present**. Unmarkable paths appear in both lists. Separately,
`combineNodeId: null` is a legitimate outcome and not an error — no store, zero
files written, or an unknown origin node.

### Combine in the web UI
Combine is a deliberate **two-step pairing**, because its whole point is joining
nodes from two different sessions. *"Mark for combine"* in a node's Inspector
raises a persistent banner naming what is marked, with a **Clear** button; the
mark survives changing the selection **and** changing the session filter, which is
what makes cross-session pairing possible at all. Then *"Combine with marked
node"* on any other node opens a confirm modal: both ids, the resolved merge
base, the per-file status table, the preflight warnings, a prominent
files-only/no-conversation notice, and an allow-conflicts opt-in that appears only
when there are conflicts. A `write_failed` renders the full partial-state report
rather than a bare error.

### `soj harvest` — the return path on the CLI
Harvest was previously API-only. It now has a first-class command:

```bash
soj harvest                     # preflight: per-file clean / conflict / identical
soj harvest --yes               # apply onto the mainline (safety snapshot first)
soj harvest --yes --mode patch  # write .sojourn-harvest.patch, mainline untouched
soj harvest --yes --allow-conflicts
```

Exit codes make the honesty contract machine-readable:

| Exit | Meaning |
|---|---|
| 0 | success |
| 1 | stopped *before* writing — preflight, local validation, every 400, daemon unreachable |
| 2 | `partial_apply` / `mainline_drift` — the mainline **was** written to; the full applied / conflicted / remaining / safety-snapshot dump goes to stderr |

Every 400 (`no_manifest`, `stale_base`, `conflicts`, `patch_incomplete`,
`read_failed`) is abort-clean: provably zero mainline writes.

### Harvest in the web UI
After a restore, the restore result grows a *"Harvest changes into project"*
button: preflight in a modal with per-file status, apply-vs-patch, an
allow-conflicts opt-in that only appears when there are conflicts, and a
partial-state report on mid-apply failure instead of a bare error.

### Retention for synthesized rewind transcripts
`soj gc` now also sweeps synthesized rewind transcripts, using the same `--days`
cutoff and the same `--run` / dry-run-by-default gate as the shadow prune, scoped
per project via the sidecar's `originSessionId` and pinned by the same rule as
snapshot trees.

**Native Claude session transcripts are never touched.** A `.jsonl` with no
sidecar is the ordinary shape of every real session, not garbage; the sweep only
ever considers a synthesized transcript paired with its sidecar, or an inert
orphan sidecar. A malformed sidecar makes a pair *more* protected, not less.

### Crash-safe rewind write ordering
The provenance sidecar is now written and renamed into place **before** the
synthesized transcript. The watcher only reacts to `.jsonl`, so by the time a
transcript can be observed its sidecar is already durable.

A crash between the two renames can now leave at worst an **orphan sidecar** —
inert, since nothing ingests a `.json`, and reclaimable by `soj gc` — instead of
an orphan **transcript**, which the watcher would ingest as a disconnected phantom
session capable of carrying false verified flags.

### Rewind no longer steals the origin session's tool nodes
Synthesized transcripts freshened line uuids but reused `tool_use` **block** ids
verbatim. Because the parser keys tool nodes on those block ids, the synthesized
session projected nodes whose ids collided with the origin's, and the store's
upsert *moved* them onto the new session. The origin lost its own tool nodes, its
ancestor chains broke, and a subsequent exact rewind of that session was falsely
refused with `"ancestor chain incomplete (orphaned parentage)"`. Restore was
affected too, via its rewind companion.

Tool block ids are now freshened as well, with `tool_use.id` and the referring
`tool_result.tool_use_id` remapped through one shared map so the parent edge
survives.

### Smaller fixes
- Snapshots now exclude `.sojourn-restore.json` and `.sojourn-harvest.patch` —
  restoring a worktree-session node could previously materialize a *stale*
  `.sojourn-harvest.patch` a user might `git apply` believing it fresh.
- Typed `SojournSnapshotError` (`cas_exhausted`) replaces a generic error on
  snapshot CAS exhaustion.
- Orphaned pre-upgrade `sojourn-index` files are cleaned up on shadow-repo init.
- `sidecar_exists` now maps to **409** on the rewind route rather than 500 — it is
  a refusal to clobber, not a daemon fault.
- `soj mcp` reports its real package version instead of a hardcoded `0.1.0`.
- The session filter now tells you when an explicit selection is hiding new
  sessions ("N new sessions aren't shown", with Show / Dismiss), so a filter set
  yesterday cannot quietly hide today's work.
- `docs/API.md` route table fixed (a stray blank line was splitting it in two,
  rendering the second half without a header) and its harvest error codes
  completed.

---

## Verification

Reproduce all of it from a clean checkout:

```bash
npm install && npm run build
npm test                        # 878 tests, 58 files
npm run validate:plugin         # 17/17
bash scripts/e2e/run-cycle.sh   # 62/62 API checks against an isolated daemon
bash scripts/demo/run-demo.sh   # 24 sections, 0 failing checks
```

| Gate | Result |
|---|---|
| `npm run build` | clean (tsc + vite + plugin bundle) |
| `npm test` | 878 passed, 58 files (see the known flakes under *Honest limits*) |
| `npm run validate:plugin` | 17/17 |
| `bash scripts/e2e/run-cycle.sh` | 62/62, 0 failed |
| `packages/web` `tsc --noEmit` | exit 0 |
| `bash scripts/demo/run-demo.sh` | 24 sections, 0 failing |

Note that `npm run build -w @sojourn/web` is `vite build` only and does **not**
typecheck; the web package is typechecked separately with `tsc --noEmit`.

A live end-to-end walkthrough with real captured output is in
[DEMO.md](DEMO.md).

---

## Honest limits

These are real and unresolved. Read this section as carefully as the feature list.

- **The Tier-2 critic has never been run against the real Anthropic API.** Its
  precision, recall, cost and latency are unmeasured. It is opt-in and can never
  produce a verified flag.
- **OpenCode support is not live-verified.** The adapter was written against
  OpenCode's documented API and has not been live-integration-tested. Every module
  carries that header and everything fails soft.
- **Harvest transfers file *contents* only.** A mode-only change (e.g. `chmod +x`
  with identical bytes) classifies as identical and is skipped; applied files are
  written with default modes; a branch entry that is itself a symlink is
  materialized as a regular file containing the target path. On the production
  path binary content round-trips byte-identically; corruption is confined to a
  utf8 fallback that a test pins as a documented limitation.
- **Combine merges files, never conversations.** `soj combine` produces a
  worktree and nothing else. No merged transcript is synthesized and neither
  source session is continued — inventing an interleaving of two real
  conversations is exactly the guess this project refuses to make. If you were
  expecting a merged conversation, combine does not do that and is not intended
  to. The same contents-only caveats as harvest apply, and a binary path both
  sides changed comes back as an **unmarkable** conflict where node A's content
  is kept and node B's side is simply absent from the output.
- **Terminal flag delivery usually shows the *previous* turn's state.** The `Stop`
  hook asks the daemon for flags on a 500 ms budget while the same `Stop` event is
  still triggering the rescan that produces this turn's flags — so the read
  normally wins the race against its own cause. This is inherent to "capture never
  blocks". Never read hook silence as a clean bill of health; run `soj flags` or
  refresh the web UI for the settled picture.
- **No launchd/systemd autostart.** `soj start` is manual and the daemon does not
  survive a reboot on its own. A deliberate scope decision, not an oversight.
- **Multi-batch turns** can hold more than one digest row per kind, and up to N×
  the per-turn budget across N debounce segments.
- **Digest auto-resolve is anchored to one node**, so in a narrow case (an
  over-budget storm spread across multiple assistant nodes in one turn) a digest
  can resolve while sibling-node claims were still bad.
- **One known flaky test, pre-existing and unfixed.**
  `packages/daemon/test/watcher.test.ts` intermittently fails under full-suite
  load because chokidar never delivers the file-add event. It is *not* a
  too-tight deadline — raising the wait from 5s to 20s was tried and did not
  help, so the event is lost rather than late. Measured on an untouched v1.2.0
  checkout it reproduced in **2 of 3** full runs; the suite is otherwise
  deterministic. Re-run the file in isolation (it passes in ~400ms) before
  treating a failure as a regression. The real fix is to stop depending on
  chokidar delivery in that test — drive the ingest path directly or inject the
  watcher event — which is deferred rather than papered over with a longer
  timeout.

  Practically: expect `npm test` to report **878 passed** on a clean run, and
  occasionally 877 with that one watcher test failing.

  A second test has also been observed to flake under load:
  `packages/daemon/test/api.test.ts`'s opencode-hook test. It is timing-sensitive
  in the same way (a fire-and-forget rescan observed from outside), passes in
  isolation, and has not been seen to fail deterministically. Treat a lone
  failure there the same way — re-run the file before calling it a regression.

---

## Upgrading

The database migrates itself. On first open, an existing DB is migrated v1 → v4
(v4 adds `nodes.merged_from`, combine's provenance edge); a running pre-v1.2.0
daemon keeps serving its old build until restarted:

```bash
soj stop && soj start
```

A stale pidfile left by a crashed daemon is handled by dead-pid detection.

---

## Documentation

- [../README.md](../README.md) — overview, quick start, feature tour
- [USAGE.md](USAGE.md) — complete user guide
- [API.md](API.md) — HTTP + WebSocket API
- [DEMO.md](DEMO.md) — end-to-end walkthrough with real captured output
- [../plugins/claude/README.md](../plugins/claude/README.md) — plugin install modes
  and hook internals
