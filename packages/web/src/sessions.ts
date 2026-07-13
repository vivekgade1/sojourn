import type { Cli } from "./types";

/** One row in the session-filter control (derived from a Journey). */
export interface SessionOption {
  sessionId: string;
  cli: Cli;
  /** ISO 8601 timestamp of the session's first node. */
  startedAt: string;
  turnCount: number;
  nodeCount: number;
}

const keyFor = (projectId: string) => `sojourn:session-filter:${projectId}`;

/** Stored selection for a project, or null when absent/malformed. */
export function loadSessionSelection(projectId: string): string[] | null {
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSessionSelection(projectId: string, ids: string[]): void {
  try {
    localStorage.setItem(keyFor(projectId), JSON.stringify(ids));
  } catch {
    // storage unavailable (private mode etc.) — selection just won't persist
  }
}

/**
 * Resolves the EFFECTIVE selected session ids: the stored selection
 * intersected with the sessions that actually exist; when nothing usable
 * remains (never chosen, empty choice, or every stored id vanished), the
 * default is ONLY the newest session — both the sane reading order and the
 * perf posture at scale.
 */
export function effectiveSessionIds(
  stored: string[] | null,
  availableNewestFirst: string[],
): Set<string> {
  if (stored) {
    const available = new Set(availableNewestFirst);
    const kept = stored.filter((id) => available.has(id));
    if (kept.length > 0) return new Set(kept);
  }
  return new Set(availableNewestFirst.slice(0, 1));
}
