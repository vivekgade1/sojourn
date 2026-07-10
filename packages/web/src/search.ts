import type { ChronoNode } from "./types";

/**
 * Case-insensitive node search across the fields a user actually thinks in:
 * gist/summary, label, kind (both raw and space-separated), node id, and —
 * for tool nodes — the tool name inside the payload. Empty/whitespace query
 * matches nothing (search off).
 */
export function searchNodes(nodes: ChronoNode[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches: string[] = [];
  for (const node of nodes) {
    const toolName =
      node.content && typeof node.content === "object" && "name" in (node.content as object)
        ? String((node.content as { name?: unknown }).name ?? "")
        : "";
    const haystack = [
      node.summary,
      node.label ?? "",
      node.kind,
      node.kind.replace(/_/g, " "),
      node.id,
      toolName,
    ]
      .join("\n")
      .toLowerCase();
    if (haystack.includes(q)) matches.push(node.id);
  }
  return matches;
}
