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
| POST | `/api/nodes/:id/rewind` | — | `RewindPlan` executed (writes a NEW synthesized transcript when mode=exact; never mutates originals). The plan is ALWAYS recomputed server-side from one transcript read — any client-posted plan body is ignored. Claude-only 400 / unknown-transcript 404 as above; 409 when the target transcript path already exists |
| POST | `/api/worktrees/harvest/preflight` | `{ worktreePath }` | `HarvestPreflight`. The worktree's `.sojourn-restore.json` resolves the origin project (mainline root + shared shadow repo); 400 `{ error, code: "no_manifest" }` when absent/unresolvable |
| POST | `/api/worktrees/harvest` | `{ worktreePath, mode: "apply" \| "patch", allowConflicts? }` | `HarvestResult` + `warnings: string[]` (mainline safety snapshot ALWAYS first). Typed errors: `{ error, code, files }` with 400 for `no_manifest`/`stale_base`/`conflicts`/`patch_incomplete`; 500 for `partial_apply`/`mainline_drift` with the honest `partial` payload (`{ applied, conflicted, remaining, safetySnapshotRef }`) in the body |
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

- Node ids are `"<cli>:<nativeUuid>"` and appear URL-encoded in routes (`encodeURIComponent`).
- Errors: `{ error: string }` with appropriate 4xx/5xx status.
- The daemon never mutates the user's `.git`; restores land in `$SOJOURN_HOME/worktrees/...`.
- `restorable` (graph route): a node is `restorable: true` when its *effective* snapshot tree — its own `snapshotRef`, or the nearest snapshotted ancestor's if it has none — exists and is reachable in the shadow snapshot repo. This equals the `treeValid` a `POST /api/nodes/:id/preflight` would report for that node. It is computed entirely over the returned in-memory node set (no per-node git call — the graph route is hit on every page load and websocket reconnect), and it is **fail-open**: a transient shadow-git error while probing a tree keeps `restorable: true` (preflight remains the hard gate before any checkout). A node with no snapshot on itself or any ancestor is always `restorable: false`.
