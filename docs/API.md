# Sojourn Daemon API (v1)

Base: `http://localhost:4177` (env `SOJOURN_PORT`). All JSON. Types refer to `@sojourn/core` `types.ts`.

## HTTP

| Method | Route | Body | Returns |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, version: string }` |
| GET | `/api/projects` | — | `Project[]` |
| GET | `/api/projects/:id/graph` | — | `{ project: Project, sessions: SessionRow[], nodes: ChronoNode[] }` (nodes carry `flags`) |
| GET | `/api/nodes/:id` | — | `ChronoNode` with `flags` + `annotations` (404 if missing) |
| GET | `/api/nodes/:id/diff` | — | `{ changes: FileChange[] }` — parent snapshot → node snapshot; `{ changes: [] }` when no snapshots |
| GET | `/api/nodes/:id/diff/file?path=P` | — | `{ patch: string }` |
| POST | `/api/nodes/:id/flags/run` | `{ tier?: "T1" \| "T2" }` (default T1) | `{ flags: StoredFlag[] }` — T2 returns 501 until critic wired; 400 if `ANTHROPIC_API_KEY` missing for T2 |
| POST | `/api/nodes/:id/preflight` | — | `RestorePreflight` |
| POST | `/api/nodes/:id/restore` | — | `RestoreResult` (400 when preflight `treeValid` is false) |
| POST | `/api/nodes/:id/annotations` | `{ text: string }` | `Annotation` |
| POST | `/api/flags/:id/dismiss` | — | `{ ok: true }` |
| POST | `/api/mark` | `{ sessionId: string, label: string, kind: "decision" \| "assumption" \| "checkpoint" }` | `ChronoNode` (parented to `latestNode(sessionId)`) |
| POST | `/api/hooks/claude` | Claude hook payload (`{session_id, transcript_path, cwd, hook_event_name}`) | `{ ok: true }` — triggers immediate re-scan of that transcript |
| POST | `/api/hooks/opencode` | `{ sessionId: string }` | `{ ok: true }` |

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
