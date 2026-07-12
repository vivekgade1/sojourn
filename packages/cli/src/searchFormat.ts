// Pure formatting/filtering helpers shared by the `soj why|decisions|gate`
// commands (program.ts) and the MCP server (mcp.ts).
//
// IMPORTANT: this module must stay free of runtime imports on @sojourn/core
// (type-only imports are fine — they are erased at compile time). mcp.ts is
// bundled/spawned standalone in tests and must not drag in native deps
// (better-sqlite3) through the core barrel.

import type { ChronoNode, SearchHit, StoredFlag } from "@sojourn/core";

/** Node kinds produced by `soj mark` / `/api/mark` — the "marks". */
export const MARK_KINDS: ReadonlySet<string> = new Set(["decision", "assumption", "checkpoint"]);

/** Flags that are still live findings: not dismissed and not auto-resolved. */
export function activeFlags(node: ChronoNode): StoredFlag[] {
  return (node.flags ?? []).filter((f) => !f.dismissed && !f.autoResolved);
}

/**
 * Plan capsule 8: `soj decisions` surfaces marks (decision/assumption/
 * checkpoint nodes) plus any node carrying active flags.
 */
export function filterDecisionHits(hits: SearchHit[]): SearchHit[] {
  return hits.filter((h) => MARK_KINDS.has(h.node.kind) || activeFlags(h.node).length > 0);
}

/** One-line gist for a node: label wins, then summary. */
export function gistOf(node: ChronoNode): string {
  const gist = (node.label ?? node.summary ?? "").trim();
  return gist.length > 0 ? gist : "(no summary)";
}

/** Collapse whitespace and hard-cap length for single-line table/log output. */
export function excerpt(text: string, max = 100): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

/** Compact, agent-friendly projection of a SearchHit (used by MCP tools). */
export interface CompactHit {
  nodeId: string;
  kind: string;
  sessionId: string;
  timestamp: string;
  score: number;
  gist: string;
  snippet: string;
  activeFlags: string[];
}

export function compactHit(hit: SearchHit): CompactHit {
  return {
    nodeId: hit.node.id,
    kind: hit.node.kind,
    sessionId: hit.node.sessionId,
    timestamp: hit.node.timestamp,
    score: hit.score,
    gist: gistOf(hit.node),
    snippet: excerpt(hit.snippet ?? "", 200),
    activeFlags: activeFlags(hit.node).map((f) => f.kind),
  };
}

/** Renders a daemon `{ error: string }` body (or anything else) as a short string. */
export function describeApiError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}
