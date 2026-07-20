# Sojourn Daemon API (v1)

Base: `http://localhost:4177` (env `SOJOURN_PORT`). All JSON. Types refer to `@sojourn/core` `types.ts`.

## HTTP

| Method | Route | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, version: string }` |
| GET | `/api/projects` | — | `Project[]` |
| GET | `/api/projects/:id/graph` | — | `{ project: Project, sessions: SessionRow[], nodes: ChronoNode[] }` (each node carries `flags` and `restorable: boolean`) |
| GET | `/api/nodes/:id` | — | `ChronoNode` with `flags` + `annotations` (404 if missing) |
| GET | `/api/nodes/:id/diff` | — | `{ changes: FileChange[] }` — parent snapshot → node snapshot; `{ changes: [] }` when no snapshots |
| GET | `/api/nodes/:id/diff/file?path=P` | — | `{ patch: string }` |
| POST | `/api/nodes/:id/flags/run` | `{ tier?: "T1" \| "T2" }` (default T1) | `{ flags: StoredFlag[] }` (the node's FULL current flag list). T2 (advisory LLM critic) is implemented: 400 when `ANTHROPIC_API_KEY` is not set on the daemon, 502 when the critic call fails |
| POST | `/api/nodes/:id/preflight` | — | `RestorePreflight` (when `treeValid` is false, `warnings[0]` explains: snapshot missing or thinned by retention policy — `soj gc`) |
| POST | `/api/nodes/:id/restore` | — | `RestoreResult` (400 when preflight `treeValid` is false); response gains a `rewind: RewindPlan` field when the session's transcript is known to the daemon — the plan is EXECUTED (synthesized transcript written) when `mode` is `exact`, or the honest tip-mode fallback otherwise; rewind failures never fail the restore (field simply omitted) |
| POST | `/api/nodes/:id/annotations` | `{ text: string }` | `Annotation` |
| POST | `/api/flags/:id/dismiss` | — | `{ ok: true }` |
| POST | `/api/mark` | `{ sessionId: string, label: string, kind: "decision" \| "assumption" \| "checkpoint" }` | `ChronoNode` (parented to `latestNode(sessionId)`) |
| POST | `/api/hooks/claude` | Claude hook payload (`{session_id, transcript_path, cwd, hook_event_name}`) | `{ ok: true }` — triggers immediate re-scan of that transcript |
| POST | `/api/hooks/opencode` | `{ sessionId: string }` | `{ ok: true }` — triggers a fire-and-forget re-scan of that OpenCode session (session + messages pulled from the local OpenCode server; fail-soft if unreachable) |
| GET | `/api/sessions/:id/health` | — | `SessionHealth` (pure counts); 404 JSON for an unknown session |
| GET | `/api/search?projectId=&q=&file=&kinds=` | — | `{ hits: SearchHit[] }` — FTS over gists/labels/annotations + files-touched index; `kinds` is a CSV of `NodeKind`s; 400 without `projectId` |
| POST | `/api/nodes/:id/rewind-plan` | — | `RewindPlan` (pure — no side effects). Claude nodes only (400 otherwise); 404 when the daemon has not yet seen the session's transcript file. Only the public `RewindPlan` fields are returned |
| POST | `/api/nodes/:id/rewind` | — | `RewindPlan` executed (writes a NEW synthesized transcript when mode=exact; never mutates originals). The plan is ALWAYS recomputed server-side from one transcript read — any client-posted plan body is ignored. Claude-only 400 / unknown-transcript 404 as above; typed 409 `{ error, code }` when either member of the output pair already exists — `transcript_exists` or `sidecar_exists` (the provenance sidecar is written first, so it is the first path that can collide). Rewind never clobbers an existing file |
| POST | `/api/worktrees/harvest/preflight` | `{ worktreePath }` | `HarvestPreflight`. The worktree's `.sojourn-restore.json` resolves the origin project (mainline root + shared shadow repo). Pure with respect to the mainline — it classifies only, and never writes there (it does take a snapshot of the *worktree* into the shadow repo to diff against). Shares the harvest routes' typed-error mapping: 400 `{ error, code, files }` for `no_manifest` (manifest absent/unreadable/unresolvable), `stale_base` (the manifest's base tree is gone from the shadow repo), and `read_failed` (a worktree file could not be read) |
| POST | `/api/worktrees/harvest` | `{ worktreePath, mode: "apply" \| "patch", allowConflicts? }` | `HarvestResult` + `warnings: string[]` (mainline safety snapshot ALWAYS first). Typed errors: `{ error, code, files }` with 400 for `no_manifest`/`stale_base`/`conflicts`/`patch_incomplete`/`read_failed` — **every 400 is abort-clean: nothing was written to the mainline** — and 500 for `partial_apply`/`mainline_drift`, which alone carry the honest `partial` payload (`{ applied, conflicted, remaining, safetySnapshotRef }`) in the body and mean the mainline WAS partially written. `read_failed` is a 400 despite being raised from the apply path too: both sites wrap the same dry classification pass over temp files, so it always aborts before any mainline write |
| POST | `/api/nodes/combine/preflight` | `{ nodeIdA, nodeIdB }` | `CombinePreflight` — `{ nodeIdA, nodeIdB, baseNodeId, baseTree, treeA, treeB, files: Array<{ path, status: "clean" \| "conflict" \| "identical", unmarkable?: boolean }>, warnings }`. **Static path — the node ids travel in the BODY, so nothing here is URL-encoded.** Genuinely pure: unlike harvest's preflight (which snapshots the live worktree) this writes nothing anywhere — not the project, not the shadow object database, not the worktrees root; base/A/B are pre-existing trees and the only filesystem activity is short-lived `os.tmpdir()` scratch for `git merge-file -p` dry runs. `warnings` is never empty: it always carries the "combine produces FILES ONLY, no transcript is synthesized" notice. Typed errors as below |
| POST | `/api/nodes/combine` | `{ nodeIdA, nodeIdB, allowConflicts? }` | `CombineResult` — `{ worktreePath, nodeIdA, nodeIdB, baseNodeId, baseTree, treeA, treeB, applied, conflicted, unmarkable, skippedIdentical, combineNodeId, warnings }`. Three-way merges the two nodes' **file states** against their nearest common ancestor into a NEW worktree; A's tree is the starting content and B is merged on top. Writes nothing outside that new worktree. **No transcript is ever synthesized.** `unmarkable` ⊆ `conflicted`: conflicts that could not take text markers (binary), where A's content was kept verbatim and B's side is NOT present — distinct from `conflicted`, which WERE written with markers. `combineNodeId: null` is **not** an error (no store / zero files written / unknown origin node) and never changes the 200. On success the daemon broadcasts `node_added` + `project_updated` for the combine node. `allowConflicts` must be the literal boolean `true` — a truthy string never opts you in |
| GET | `/api/sessions/:id/turn-flags?sinceNodeId=` | — | `{ lines: string[] }` — the turn's ACTIVE verified flags as compact one-liners, max 3 + a `"+n more"` marker; advisory flags never appear. When `sinceNodeId` is omitted (the Stop hook omits it), defaults to the session's LAST turn (from its final prompt node onward); 404 for an unknown session or a `sinceNodeId` not in the session |

Static: serves `packages/web/dist` at `/` when built.

## WebSocket `/ws`

Server → client events (JSON):

```ts
{ type: "node_added", node: ChronoNode }
{ type: "flags_updated", nodeId: string, flags: StoredFlag[] }
{ type: "project_updated", projectId: string }
```

## Conventions

- Node ids are `"<cli>:<nativeUuid>"` and appear URL-encoded in routes (`encodeURIComponent`) — **except** the two combine routes, whose paths are static and carry both ids in the request body. Do not encode them there.
- **Combine route ordering is load-bearing.** `/api/nodes/combine/preflight` and `/api/nodes/combine` are registered **before** the whole `/api/nodes/:id/...` family. Express matches in registration order, so `/api/nodes/:id/preflight` would otherwise capture `/api/nodes/combine/preflight` with `id="combine"` and hand the request to the **restore** engine. `packages/daemon/test/apiV2.test.ts` pins this with an explicit shadowing test, so moving them breaks loudly rather than silently.
- Errors: `{ error: string }` with appropriate 4xx/5xx status.
- **Combine's typed errors** are `{ error, code, files }`, and the abort-clean line is sharper than harvest's. Body-validation failures (missing/blank `nodeIdA` or `nodeIdB`, or `nodeIdA === nodeIdB`) are a 400 with **no `code` field at all** — they never reach the engine, and only engine refusals are typed. Every engine code except one is a **400 that is provably zero-write**, raised before the output worktree directory is even claimed: `not_found` (a node id, or its project, is unknown — a 400 rather than a 404, because these are body-supplied ids on a static path), `cross_project`, `no_common_ancestor`, `no_tree`, `conflicts`, `read_failed`, `dest_exhausted`. The sole exception is **`write_failed` — the only 500, and the only code that leaves anything on disk.** Its body additionally carries `partial: { worktreePath, applied, conflicted, remaining }` naming the half-built worktree, which is **deliberately not deleted**: it holds real merged content, and removing it would make combine a source of data loss. `soj combine` mirrors the split exactly — exit 1 for everything abort-clean, exit 2 for `write_failed`.
- The daemon never mutates the user's `.git`; restores land in `$SOJOURN_HOME/worktrees/...`.
- `restorable` (graph route): a node is `restorable: true` when its *effective* snapshot tree — its own `snapshotRef`, or the nearest snapshotted ancestor's if it has none — exists and is reachable in the shadow snapshot repo. This equals the `treeValid` a `POST /api/nodes/:id/preflight` would report for that node. It is computed entirely over the returned in-memory node set (no per-node git call — the graph route is hit on every page load and websocket reconnect), and it is **fail-open**: a transient shadow-git error while probing a tree keeps `restorable: true` (preflight remains the hard gate before any checkout). A node with no snapshot on itself or any ancestor is always `restorable: false`.
