import type { ChronoNode, IngestBatch, NodeKind } from "@sojourn/core";

/**
 * Written against the documented OpenCode server/SDK API
 * (https://opencode.ai/docs/server/, https://opencode.ai/docs/sdk/) as of
 * implementation time. NOT integration-tested against a live OpenCode
 * install in this environment — there is no OpenCode server available here.
 * Shapes below (message = `{info, parts}`, parts with `type: "text" | "tool"`,
 * tool parts carrying `callID`/`tool`/`state.input`/`state.output`) reflect
 * the documented SDK types; this parser fails soft (never throws) on any
 * message/part shape that doesn't match, so drift in the live API degrades
 * gracefully instead of crashing ingestion.
 *
 * Mirrors the node-mapping conventions of the committed Claude parser
 * (packages/adapter-claude/src/parser.ts): node id `opencode:<nativeId>`,
 * parallel tool parts are SIBLINGS under the preceding text part's node
 * (fan-out, never chained tool-under-tool), all children are kept (no
 * sibling-drop), and summaries are the first 120 chars.
 *
 * OpenCode's tool part differs from Claude's tool_use/tool_result split: a
 * single "tool" part carries both the call (tool name + input) and, once
 * finished, the result (state.output) inline. To keep the ChronoNode model
 * uniform across CLIs, each tool part that has reached a terminal state
 * ("completed" or "error") is split into TWO ChronoNodes: a `tool_use` node
 * (native id = the part's callID) and a `tool_result` child node (native id
 * = `${callID}#result`) parented to it. Tool parts still pending/running
 * (no output yet) produce only the `tool_use` node.
 */

interface ProjectInfo {
  root: string;
  name: string;
}

export function parseOpenCodeMessages(
  messages: unknown,
  sessionId: string,
  project: ProjectInfo,
): IngestBatch | null {
  if (!Array.isArray(messages)) return null;

  const nodes: ChronoNode[] = [];
  // Cursor for "current parent", threaded across message boundaries. See
  // handleAssistantMessage doc comment below for the fan-out rule this
  // implements. Kept as a local (not module-level) so concurrent/repeated
  // calls to parseOpenCodeMessages never share state.
  const cursor: { parentId: string | null } = { parentId: null };

  for (const entry of messages) {
    if (!isRecord(entry)) continue;
    const info = entry.info;
    const parts = entry.parts;
    if (!isRecord(info) || !Array.isArray(parts)) continue;

    const role = info.role;
    const msgTime = extractTime(info.time);

    if (role === "user") {
      handleUserMessage(parts, sessionId, msgTime, nodes, cursor);
    } else if (role === "assistant") {
      handleAssistantMessage(parts, sessionId, msgTime, nodes, cursor);
    }
    // Other/unknown roles: not part of the v1 node mapping, skip.
  }

  if (nodes.length === 0) return null;

  return {
    project,
    session: { id: sessionId, cli: "opencode" },
    nodes,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractTime(time: unknown): string {
  if (isRecord(time) && typeof time.created === "number") {
    return new Date(time.created).toISOString();
  }
  if (typeof time === "string") return time;
  return "";
}

function nodeIdFor(nativeId: string): string {
  return `opencode:${nativeId}`;
}

function summarize(text: string): string {
  return text.slice(0, 120);
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
    cli: "opencode",
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

/**
 * User messages in the v1 mapping produce a single prompt node from the
 * first usable text part. Any other part types on a user message (rare;
 * OpenCode user messages are typically plain text) are skipped.
 */
function handleUserMessage(
  parts: unknown[],
  sessionId: string,
  timestamp: string,
  nodes: ChronoNode[],
  cursor: { parentId: string | null },
): void {
  const textPart = parts.find(
    (p) => isRecord(p) && p.type === "text" && typeof p.text === "string",
  ) as Record<string, unknown> | undefined;
  if (!textPart) return;
  const partId = textPart.id;
  if (typeof partId !== "string" || partId.length === 0) return;
  const text = textPart.text as string;

  const node = makeNode({
    nativeUuid: partId,
    parentId: cursor.parentId,
    kind: "prompt",
    sessionId,
    timestamp,
    summary: summarize(text),
    content: textPart,
  });
  nodes.push(node);
  cursor.parentId = node.id;
}

/**
 * OpenCode delivers messages as a flat ordered list (no explicit parentId
 * linkage like Claude's parentUuid), so the chain is threaded across message
 * boundaries via `cursor`: each new text part (prompt or assistant) becomes
 * the new parent for whatever follows, and tool parts fan out as siblings
 * under the most recent text node without advancing the cursor. This
 * mirrors the Claude parser's per-line "currentParent" rule but persists
 * across the whole session instead of resetting per line.
 */
function handleAssistantMessage(
  parts: unknown[],
  sessionId: string,
  timestamp: string,
  nodes: ChronoNode[],
  cursor: { parentId: string | null },
): void {
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const type = part.type;

    if (type === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      const partId = part.id;
      if (typeof partId !== "string" || partId.length === 0) continue;
      const node = makeNode({
        nativeUuid: partId,
        parentId: cursor.parentId,
        kind: "assistant",
        sessionId,
        timestamp,
        summary: summarize(text),
        content: part,
      });
      nodes.push(node);
      cursor.parentId = node.id;
    } else if (type === "tool") {
      const callId = part.callID;
      if (typeof callId !== "string" || callId.length === 0) continue; // can't address a tool part without its callID
      const toolName = typeof part.tool === "string" ? part.tool : "tool";
      const state = isRecord(part.state) ? part.state : undefined;
      const input = state?.input;

      const toolNode = makeNode({
        nativeUuid: callId,
        parentId: cursor.parentId,
        kind: "tool_use",
        sessionId,
        timestamp,
        summary: summarize(`${toolName} ${firstArgSummary(input)}`.trim()),
        content: part,
      });
      nodes.push(toolNode);
      // Do NOT advance the cursor: parallel tool parts are siblings.

      const status = state?.status;
      if (status === "completed" || status === "error") {
        const resultNativeId = `${callId}#result`;
        const output = status === "error" ? (state?.error ?? state?.output) : state?.output;
        const resultNode = makeNode({
          nativeUuid: resultNativeId,
          parentId: toolNode.id,
          kind: "tool_result",
          sessionId,
          timestamp,
          summary: summarize(toolResultText(output)),
          content: output,
        });
        nodes.push(resultNode);
      }
    }
    // other part types (e.g. "step-start", "step-finish", "reasoning",
    // "file", "patch"): not part of the v1 node mapping, skip without
    // changing the parent cursor.
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const first = content.find((b) => isRecord(b) && typeof b.text === "string");
    if (first && isRecord(first) && typeof first.text === "string") return first.text as string;
  }
  if (isRecord(content) && typeof content.text === "string") return content.text;
  return "";
}

// Preferred keys (in priority order) for the tool part's "first arg" summary.
const PREFERRED_SUMMARY_KEYS = [
  "filePath",
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
