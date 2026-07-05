import path from "node:path";
import type { ChronoNode, IngestBatch, NodeKind } from "@sojourn/core";

/**
 * Parses a Claude Code session transcript (JSONL, one JSON object per line)
 * into an `IngestBatch`. The transcript is the canonical ground truth for a
 * session (see project CLAUDE.md); this parser must never throw on
 * malformed/unexpected input — it skips what it can't handle and keeps going.
 *
 * Returns null when the raw text yields no usable nodes (empty file, every
 * line malformed, or every line of a kind we skip in v1).
 */
export function parseSessionJsonl(filePath: string, raw: string): IngestBatch | null {
  const lines = raw.split("\n");

  const nodes: ChronoNode[] = [];
  const cwdCounts = new Map<string, number>();
  let sessionId: string | undefined;

  // Maps a transcript-native id (line uuid, or content-block id/uuid#i) to
  // the ChronoNode id we assigned it, so later lines can resolve parents.
  const nativeIdToNodeId = new Map<string, string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // malformed line: skip silently, keep parsing
    }

    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;

    if (typeof rec.cwd === "string" && rec.cwd.length > 0) {
      cwdCounts.set(rec.cwd, (cwdCounts.get(rec.cwd) ?? 0) + 1);
    }
    if (!sessionId && typeof rec.sessionId === "string" && rec.sessionId.length > 0) {
      sessionId = rec.sessionId;
    }

    const type = rec.type;
    if (type === "summary" || type === "system") continue; // skip in v1
    if (rec.isSidechain === true) continue; // skip in v1

    if (type === "user") {
      handleUserLine(rec, nodes, nativeIdToNodeId);
    } else if (type === "assistant") {
      handleAssistantLine(rec, nodes, nativeIdToNodeId);
    }
    // any other line type (last-prompt, mode, permission-mode, attachment,
    // custom-title, agent-name, etc.): not part of the v1 node mapping, skip.
  }

  if (nodes.length === 0) return null;

  const root = mostCommonCwd(cwdCounts) ?? "";
  const resolvedSessionId = sessionId ?? path.basename(filePath, path.extname(filePath));

  return {
    project: { root, name: path.basename(root) || root },
    session: { id: resolvedSessionId, cli: "claude" },
    nodes,
  };
}

function mostCommonCwd(counts: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestCount = -1;
  for (const [cwd, count] of counts) {
    if (count > bestCount) {
      best = cwd;
      bestCount = count;
    }
  }
  return best;
}

function nodeIdFor(nativeUuid: string): string {
  return `claude:${nativeUuid}`;
}

function resolveParentId(
  parentUuid: unknown,
  nativeIdToNodeId: Map<string, string>,
): string | null {
  if (typeof parentUuid !== "string" || parentUuid.length === 0) return null;
  return nativeIdToNodeId.get(parentUuid) ?? null;
}

function makeNode(params: {
  nativeUuid: string;
  parentId: string | null;
  kind: NodeKind;
  sessionId: string;
  timestamp: string;
  summary: string;
  content: unknown;
}): ChronoNode {
  return {
    id: nodeIdFor(params.nativeUuid),
    parentId: params.parentId,
    kind: params.kind,
    cli: "claude",
    sessionId: params.sessionId,
    // Filled in by the daemon at ingest time (see IngestBatch doc comment).
    projectId: "",
    timestamp: params.timestamp,
    snapshotRef: null,
    label: null,
    summary: params.summary,
    content: params.content,
    meta: { nativeUuid: params.nativeUuid },
  };
}

function summarize(text: string): string {
  return text.slice(0, 120);
}

function textOf(rec: Record<string, unknown>): string | undefined {
  const timestamp = rec.timestamp;
  return typeof timestamp === "string" ? timestamp : undefined;
}

function handleUserLine(
  rec: Record<string, unknown>,
  nodes: ChronoNode[],
  nativeIdToNodeId: Map<string, string>,
): void {
  const uuid = rec.uuid;
  if (typeof uuid !== "string" || uuid.length === 0) return;
  const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
  const timestamp = textOf(rec) ?? "";
  const message = rec.message;
  if (typeof message !== "object" || message === null) return;
  const content = (message as Record<string, unknown>).content;

  if (typeof content === "string") {
    // plain user prompt
    const parentId = resolveParentId(rec.parentUuid, nativeIdToNodeId);
    const node = makeNode({
      nativeUuid: uuid,
      parentId,
      kind: "prompt",
      sessionId,
      timestamp,
      summary: summarize(content),
      content,
    });
    nodes.push(node);
    nativeIdToNodeId.set(uuid, node.id);
    return;
  }

  if (Array.isArray(content)) {
    const toolResultBlocks = content.filter(
      (b) => isRecord(b) && b.type === "tool_result",
    ) as Record<string, unknown>[];

    if (toolResultBlocks.length > 0) {
      // user line whose content is tool_result blocks: one tool_result node
      // PER block, each parented to its own matching tool_use node (fall
      // back to the line's parentUuid). Keep all siblings.
      const fallbackParentId = resolveParentId(rec.parentUuid, nativeIdToNodeId);
      for (let i = 0; i < toolResultBlocks.length; i++) {
        const block = toolResultBlocks[i];
        const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const parentId =
          (toolUseId ? nativeIdToNodeId.get(toolUseId) : undefined) ?? fallbackParentId;
        const nativeUuid = i === 0 ? uuid : `${uuid}#${i}`;
        const blockContent = block.content;
        const node = makeNode({
          nativeUuid,
          parentId,
          kind: "tool_result",
          sessionId,
          timestamp,
          summary: summarize(toolResultText(blockContent)),
          content: blockContent,
        });
        nodes.push(node);
        nativeIdToNodeId.set(nativeUuid, node.id);
      }
      return;
    }

    // Array content with no tool_result blocks (e.g. [{type:"text",...}]):
    // treat as a plain prompt, using the first text block found.
    const textBlock = content.find((b) => isRecord(b) && b.type === "text") as
      | Record<string, unknown>
      | undefined;
    const text = textBlock && typeof textBlock.text === "string" ? textBlock.text : "";
    const parentId = resolveParentId(rec.parentUuid, nativeIdToNodeId);
    const node = makeNode({
      nativeUuid: uuid,
      parentId,
      kind: "prompt",
      sessionId,
      timestamp,
      summary: summarize(text),
      content,
    });
    nodes.push(node);
    nativeIdToNodeId.set(uuid, node.id);
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const first = content.find((b) => isRecord(b) && typeof b.text === "string");
    if (first && isRecord(first) && typeof first.text === "string") return first.text;
  }
  return "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function handleAssistantLine(
  rec: Record<string, unknown>,
  nodes: ChronoNode[],
  nativeIdToNodeId: Map<string, string>,
): void {
  const uuid = rec.uuid;
  if (typeof uuid !== "string" || uuid.length === 0) return;
  const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
  const timestamp = textOf(rec) ?? "";
  const message = rec.message;
  if (typeof message !== "object" || message === null) return;
  const content = (message as Record<string, unknown>).content;

  const blocks: Record<string, unknown>[] = Array.isArray(content)
    ? (content.filter(isRecord) as Record<string, unknown>[])
    : typeof content === "string"
      ? [{ type: "text", text: content }]
      : [];

  // Parentage rule (resolved spec ambiguity — "keep all children / no
  // parallel-tool-call sibling-drop"): currentParent starts at the line's
  // parentUuid-mapped node. A text block creates its node parented to
  // currentParent, then ADVANCES currentParent to itself (text blocks
  // chain). A tool_use block creates its node parented to currentParent but
  // does NOT advance currentParent — so multiple tool_use blocks in a row
  // are siblings sharing the same parent (the preceding text node, or the
  // line parent if no text block precedes them), never chained to each
  // other.
  let currentParent: string | null = resolveParentId(rec.parentUuid, nativeIdToNodeId);
  let textBlockIndex = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockType = block.type;

    if (blockType === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      const nativeUuid = textBlockIndex === 0 ? uuid : `${uuid}#${textBlockIndex}`;
      textBlockIndex++;
      const node = makeNode({
        nativeUuid,
        parentId: currentParent,
        kind: "assistant",
        sessionId,
        timestamp,
        summary: summarize(text),
        content: block,
      });
      nodes.push(node);
      nativeIdToNodeId.set(nativeUuid, node.id);
      currentParent = node.id;
    } else if (blockType === "tool_use") {
      const id = typeof block.id === "string" ? block.id : undefined;
      if (!id) continue; // can't address a tool_use without its block id
      const name = typeof block.name === "string" ? block.name : "tool";
      const input = block.input;
      const node = makeNode({
        nativeUuid: id,
        parentId: currentParent,
        kind: "tool_use",
        sessionId,
        timestamp,
        summary: summarize(`${name} ${firstArgSummary(input)}`.trim()),
        content: block,
      });
      nodes.push(node);
      nativeIdToNodeId.set(id, node.id);
      // Do NOT advance currentParent: parallel tool_use blocks are siblings.
    }
    // other block types (e.g. "thinking"): not part of the v1 node mapping,
    // skip without changing currentParent.
  }
}

// Preferred keys (in priority order) for the tool_use summary's "first arg".
// Using a fixed key preference instead of raw object/insertion order keeps
// summaries meaningful and stable regardless of how a given tool orders its
// input properties.
const PREFERRED_SUMMARY_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "prompt",
  "description",
];

function firstArgSummary(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const key of PREFERRED_SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  const values = Object.values(input);
  const first = values.find((v) => typeof v === "string") as string | undefined;
  return first ?? "";
}
