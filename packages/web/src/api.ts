import type {
  Annotation,
  ChronoNode,
  FileChange,
  GraphResponse,
  Project,
  RestorePreflight,
  RestoreResult,
  StoredFlag,
} from "./types";

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
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // ignore body parse failure, keep status text
    }
    throw new Error(message);
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
