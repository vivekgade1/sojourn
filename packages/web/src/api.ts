import type {
  Annotation,
  ChronoNode,
  CombinePartialState,
  CombinePreflight,
  CombineResult,
  FileChange,
  GraphResponse,
  Project,
  HarvestOutcome,
  HarvestPartialState,
  HarvestPreflight,
  RestorePreflight,
  RestoreResult,
  StoredFlag,
} from "./types";

/**
 * The two structurally different `partial` payloads a 500 can carry. They are
 * told apart by shape, never by which call produced them — see the two
 * predicates below. Harvest's has a `safetySnapshotRef` (it wrote to your
 * project); combine's has a `worktreePath` (it only ever wrote inside a new
 * worktree).
 */
export type ApiPartialState = HarvestPartialState | CombinePartialState;

export function isHarvestPartial(p: ApiPartialState): p is HarvestPartialState {
  return typeof (p as HarvestPartialState).safetySnapshotRef === "string";
}

export function isCombinePartial(p: ApiPartialState): p is CombinePartialState {
  return typeof (p as CombinePartialState).worktreePath === "string";
}

/**
 * Everything `request` throws, and a plain `Error` subclass — so every
 * existing `e instanceof Error ? e.message : String(e)` caller keeps working
 * unchanged and still reads the same `message`. The extra fields are purely
 * additive, for callers that need to tell a semantic error apart from a
 * generic one:
 *
 * - `status` — 400 means the server refused BEFORE writing anything;
 *   500 (`partial_apply`/`mainline_drift`) means it wrote and then failed.
 * - `code` — the daemon's typed error code. OPTIONAL: input-validation 400s
 *   (missing `worktreePath`, bad `mode`) carry `{ error }` and nothing else.
 * - `partial` — present only alongside harvest's `partial_apply`/
 *   `mainline_drift` or combine's `write_failed`. Two different shapes; narrow
 *   with `isHarvestPartial` / `isCombinePartial` before rendering.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly files: string[];
  readonly partial: ApiPartialState | null;

  constructor(
    message: string,
    status: number,
    code: string | null = null,
    files: string[] = [],
    partial: ApiPartialState | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.files = files;
    this.partial = partial;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | null = null;
    let files: string[] = [];
    let partial: ApiPartialState | null = null;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      if (typeof body?.code === "string") code = body.code;
      if (Array.isArray(body?.files)) files = body.files as string[];
      if (body?.partial) partial = body.partial as ApiPartialState;
    } catch {
      // ignore body parse failure, keep status text
    }
    throw new ApiError(message, res.status, code, files, partial);
  }
  return res.json() as Promise<T>;
}

const encId = (id: string) => encodeURIComponent(id);

export const api = {
  health: () => request<{ ok: true; version: string }>("/api/health"),

  listProjects: () => request<Project[]>("/api/projects"),

  getGraph: (projectId: string) =>
    request<GraphResponse>(`/api/projects/${encodeURIComponent(projectId)}/graph`),

  getNode: (nodeId: string) => request<ChronoNode>(`/api/nodes/${encId(nodeId)}`),

  getDiff: (nodeId: string) =>
    request<{ changes: FileChange[] }>(`/api/nodes/${encId(nodeId)}/diff`),

  getFileDiff: (nodeId: string, path: string) =>
    request<{ patch: string }>(
      `/api/nodes/${encId(nodeId)}/diff/file?path=${encodeURIComponent(path)}`,
    ),

  runFlags: (nodeId: string, tier: "T1" | "T2" = "T1") =>
    request<{ flags: StoredFlag[] }>(`/api/nodes/${encId(nodeId)}/flags/run`, {
      method: "POST",
      body: JSON.stringify({ tier }),
    }),

  preflight: (nodeId: string) =>
    request<RestorePreflight>(`/api/nodes/${encId(nodeId)}/preflight`, { method: "POST" }),

  restore: (nodeId: string) =>
    request<RestoreResult>(`/api/nodes/${encId(nodeId)}/restore`, { method: "POST" }),

  harvestPreflight: (worktreePath: string) =>
    request<HarvestPreflight>("/api/worktrees/harvest/preflight", {
      method: "POST",
      body: JSON.stringify({ worktreePath }),
    }),

  harvest: (worktreePath: string, mode: "apply" | "patch", allowConflicts = false) =>
    request<HarvestOutcome>("/api/worktrees/harvest", {
      method: "POST",
      body: JSON.stringify({ worktreePath, mode, allowConflicts }),
    }),

  // Combine — STATIC paths with the ids in the BODY. There is no `:id` param
  // and nothing to encode; the daemon registers these ahead of the
  // `/api/nodes/:id/...` family precisely so they can't be swallowed by it.
  combinePreflight: (nodeIdA: string, nodeIdB: string) =>
    request<CombinePreflight>("/api/nodes/combine/preflight", {
      method: "POST",
      body: JSON.stringify({ nodeIdA, nodeIdB }),
    }),

  combine: (nodeIdA: string, nodeIdB: string, allowConflicts = false) =>
    request<CombineResult>("/api/nodes/combine", {
      method: "POST",
      body: JSON.stringify({ nodeIdA, nodeIdB, allowConflicts }),
    }),

  addAnnotation: (nodeId: string, text: string) =>
    request<Annotation>(`/api/nodes/${encId(nodeId)}/annotations`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  dismissFlag: (flagId: number) =>
    request<{ ok: true }>(`/api/flags/${flagId}/dismiss`, { method: "POST" }),

  mark: (sessionId: string, label: string, kind: "decision" | "assumption" | "checkpoint") =>
    request<ChronoNode>("/api/mark", {
      method: "POST",
      body: JSON.stringify({ sessionId, label, kind }),
    }),
};
