import type { ChronoNode } from "./types";

export interface Turn {
  /** id of the turn's first node — stable, unique within the journey. */
  id: string;
  /** 1-based waypoint number within the session. */
  index: number;
  /** The prompt that opened the turn (null for a pre-prompt preamble). */
  promptNode: ChronoNode | null;
  /** Every node in the turn, chronological. */
  nodes: ChronoNode[];
  /** What the user asked (prompt gist), or a fallback for preambles. */
  ask: string;
  /** First assistant text of the turn (what the agent said it did). */
  gist: string;
  toolCount: number;
  toolNames: string[];
  verifiedCount: number;
  advisoryCount: number;
  /** decision / assumption / checkpoint nodes inside the turn. */
  marks: ChronoNode[];
  /** This turn contains the session's latest node. */
  isHere: boolean;
}

export interface Journey {
  sessionId: string;
  cli: ChronoNode["cli"];
  turns: Turn[];
  startedAt: string;
  nodeCount: number;
}

const MARK_KINDS = new Set<ChronoNode["kind"]>(["decision", "assumption", "checkpoint"]);

function activeFlagCount(node: ChronoNode, tier: "verified" | "advisory"): number {
  return (node.flags ?? []).filter((f) => f.tier === tier && !f.dismissed && !f.autoResolved).length;
}

function toolNameOf(node: ChronoNode): string | null {
  if (node.kind !== "tool_use") return null;
  const content = node.content;
  if (content && typeof content === "object" && "name" in (content as object)) {
    const name = (content as { name?: unknown }).name;
    if (typeof name === "string" && name) return name;
  }
  return null;
}

/**
 * Groups a project's nodes into per-session journeys of TURNS. A turn opens
 * at each `prompt` node and collects everything until the next prompt.
 * Grouping is purely CHRONOLOGICAL (timestamp, then id) — deliberately not
 * parentage-based, so fragmented/orphaned parent links (e.g. data captured
 * by older builds) can never shatter the view.
 */
export function buildJourneys(nodes: ChronoNode[]): Journey[] {
  const bySession = new Map<string, ChronoNode[]>();
  for (const node of nodes) {
    const list = bySession.get(node.sessionId) ?? [];
    list.push(node);
    bySession.set(node.sessionId, list);
  }

  const journeys: Journey[] = [];
  for (const [sessionId, sessionNodes] of bySession) {
    const ordered = [...sessionNodes].sort((a, b) =>
      a.timestamp === b.timestamp ? (a.id < b.id ? -1 : 1) : a.timestamp < b.timestamp ? -1 : 1,
    );
    const latestId = ordered[ordered.length - 1]!.id;

    const groups: ChronoNode[][] = [];
    let current: ChronoNode[] = [];
    for (const node of ordered) {
      if (node.kind === "prompt" && current.length > 0) {
        groups.push(current);
        current = [];
      }
      current.push(node);
    }
    if (current.length > 0) groups.push(current);

    const turns: Turn[] = groups.map((group, i) => {
      const promptNode = group[0]!.kind === "prompt" ? group[0]! : null;
      const firstAssistant = group.find((n) => n.kind === "assistant");
      const toolUses = group.filter((n) => n.kind === "tool_use");
      const toolNames = [...new Set(toolUses.map(toolNameOf).filter((n): n is string => !!n))];
      return {
        id: group[0]!.id,
        index: i + 1,
        promptNode,
        nodes: group,
        ask: promptNode ? (promptNode.label ?? promptNode.summary) : "(session preamble)",
        gist: firstAssistant ? (firstAssistant.label ?? firstAssistant.summary) : "",
        toolCount: toolUses.length,
        toolNames,
        verifiedCount: group.reduce((sum, n) => sum + activeFlagCount(n, "verified"), 0),
        advisoryCount: group.reduce((sum, n) => sum + activeFlagCount(n, "advisory"), 0),
        marks: group.filter((n) => MARK_KINDS.has(n.kind)),
        isHere: group.some((n) => n.id === latestId),
      };
    });

    journeys.push({
      sessionId,
      cli: ordered[0]!.cli,
      turns,
      startedAt: ordered[0]!.timestamp,
      nodeCount: ordered.length,
    });
  }

  // Newest journey first — the trail you're on is the first one you see.
  journeys.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return journeys;
}

/** Maps every node id to the id of the turn that contains it. */
export function nodeToTurnIndex(journeys: Journey[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const journey of journeys) {
    for (const turn of journey.turns) {
      for (const node of turn.nodes) index.set(node.id, turn.id);
    }
  }
  return index;
}
