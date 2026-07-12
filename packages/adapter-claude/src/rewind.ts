import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ChronoNode, NodeKind, RewindPlan } from "@sojourn/core";
import { parseSessionJsonl } from "./parser.js";

/**
 * Exact-node conversation rewind via transcript synthesis.
 *
 * `planRewind` is pure: it walks the target node's ancestor chain and decides
 * whether an EXACT rewind (a brand-new synthesized `.jsonl` in the Claude
 * projects dir, resumable with `claude --resume <newSessionId>`) is honestly
 * possible. When it is not — orphaned parentage, a compaction/summary
 * boundary inside the chain, or transcript lines we cannot locate — it
 * REFUSES exact mode and falls back to `mode: "tip"` (native
 * `--fork-session` from the original session's tip), with `refusedReason`
 * explaining why. Refusing is always preferred over guessing: a transcript
 * we cannot faithfully reconstruct must never be fabricated.
 *
 * `executeRewind` performs the write. It only ever creates NEW files (never
 * mutates an existing transcript), writes atomically (tmp + rename), and
 * round-trip-validates the synthesized transcript through the same parser
 * that produced the graph — deleting the file and throwing if the projection
 * doesn't match the plan.
 */

/** Stable machine-readable classification for a `SojournRewindError`. */
export type SojournRewindErrorCode =
  | "plan_invalid"
  | "transcript_exists"
  | "write_failed"
  | "validation_mismatch";

export class SojournRewindError extends Error {
  readonly code: SojournRewindErrorCode;

  constructor(message: string, code: SojournRewindErrorCode) {
    super(message);
    this.name = "SojournRewindError";
    this.code = code;
  }
}

/**
 * A `RewindPlan` (the daemon-facing contract from `@sojourn/core`) extended
 * with the data `executeRewind` needs, so the plan → execute handoff is a
 * single value and execute never re-derives chain membership on its own:
 *
 * - `lineIndexes`: indexes into the SAME `rawLines` array the plan was built
 *   from, ascending — the chain's source lines (plus any sibling tool_result
 *   host lines pulled in to avoid mid-file dangling tool_use blocks), ending
 *   at the target's line.
 * - `lineUuids`: parallel to `lineIndexes` — each included ORIGINAL line's
 *   uuid. `executeRewind` asserts these against `rawLines` before writing
 *   anything, so a transcript that drifted between plan and execute fails
 *   fast as `plan_invalid` instead of synthesizing from the wrong lines.
 * - `expectedKinds`: the chain projection — the node kinds (in parse order)
 *   that parsing exactly those source lines yields. Used by execute's
 *   round-trip validation.
 * - `expectedParentIndexes`: the chain projection's parent SHAPE — for each
 *   projected node, the index (into the projection) of its parent; `null`
 *   for a root, `-1` for a parent outside the projection. Node ids cancel
 *   out, so the shape is directly comparable between the original-lines
 *   projection and the freshly-uuid'd synthesized one.
 * - `sessionId`: the ORIGINAL session id (rewritten to `newSessionId` in the
 *   synthesized file).
 * - `targetNodeId`: the GRAPH node id the rewind targets — recorded in the
 *   provenance sidecar so the daemon can parent the synthesized session to
 *   its origin instead of ingesting a disconnected phantom (must-fix I3).
 */
export interface ClaudeRewindPlan extends RewindPlan {
  sessionId: string;
  targetNodeId: string;
  lineIndexes: number[];
  lineUuids: string[];
  expectedKinds: NodeKind[];
  expectedParentIndexes: (number | null)[];
}

/**
 * Provenance sidecar written by `executeRewind` NEXT TO the synthesized
 * transcript (`<newSessionId>.sojourn-rewind.json`). Transcript line content
 * itself is never mutated to carry provenance — `claude --resume` must load
 * exactly native shape — so this separate file is the only channel telling
 * the daemon's ingest that (a) the session forked off `originNodeId` and
 * (b) lines with these uuids are synthesized HISTORY, not new agent claims
 * (T1 flag runs must skip them). Watchers ignore it by extension (.json,
 * not .jsonl).
 */
export interface RewindSidecar {
  originSessionId: string;
  originNodeId: string;
  /** The SYNTHESIZED transcript's line uuids, in file order. */
  lineUuids: string[];
}

/** The sidecar path for a synthesized transcript path. */
export function rewindSidecarPathFor(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, "") + ".sojourn-rewind.json";
}

export interface PlanRewindInput {
  /** All known nodes for the session (or at least the target's ancestry). */
  nodes: ChronoNode[];
  targetNodeId: string;
  /** The ORIGINAL transcript, split into lines (`raw.split("\n")`). */
  rawLines: string[];
  /** Absolute path to the Claude projects subdir the new file will live in. */
  projectsSubdir: string;
  /** The original session id (used for the tip-mode fallback command). */
  sessionId: string;
}

const REASON_ORPHAN = "ancestor chain incomplete (orphaned parentage)";
const REASON_CYCLE = "ancestor chain contains a cycle (corrupt parentage)";
const REASON_BOUNDARY =
  "chain crosses a compaction/summary boundary; exact context cannot be reconstructed";
const REASON_MISSING_LINES = "transcript lines missing for chain";
const REASON_NO_TARGET = "target node not found in node set";
const REASON_ROOT_UNRESOLVED = "transcript root has unresolved parent (truncated file?)";

function refuse(sessionId: string, targetNodeId: string, reason: string): ClaudeRewindPlan {
  return {
    mode: "tip",
    newSessionId: null,
    transcriptPath: null,
    refusedReason: reason,
    resumeCommand: `claude --resume ${sessionId} --fork-session`,
    sessionId,
    targetNodeId,
    lineIndexes: [],
    lineUuids: [],
    expectedKinds: [],
    expectedParentIndexes: [],
  };
}

interface ParsedRawLine {
  index: number;
  rec: Record<string, unknown>;
}

/** Best-effort JSON parse of each raw line; malformed lines are skipped
 * (mirrors the parser's tolerance — they carry no chain content). */
function parseRawLines(rawLines: string[]): ParsedRawLine[] {
  const out: ParsedRawLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const trimmed = rawLines[i].trim();
    if (trimmed.length === 0) continue;
    try {
      const rec: unknown = JSON.parse(trimmed);
      if (typeof rec === "object" && rec !== null) {
        out.push({ index: i, rec: rec as Record<string, unknown> });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** A line that makes exact reconstruction dishonest if it sits inside the
 * chain's line range: session summaries, compaction markers, sidechains. */
function isBoundaryLine(rec: Record<string, unknown>): boolean {
  if (rec.type === "summary") return true;
  if (rec.isSidechain === true) return true;
  if (rec.isCompactSummary === true) return true;
  if (rec.type === "system" && rec.subtype === "compact_boundary") return true;
  return false;
}

/** The record's `message.content` blocks, when it has array content. */
function contentBlocksOf(rec: Record<string, unknown>): Record<string, unknown>[] {
  const message = rec.message;
  if (typeof message !== "object" || message === null) return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.filter(
    (b): b is Record<string, unknown> => typeof b === "object" && b !== null,
  );
}

/**
 * Builds a lookup from every native id the parser can address to the raw
 * line hosting it, mirroring `parseSessionJsonl`'s addressing scheme:
 * - a line's `uuid` (and derived `uuid#i` block ids) → that line;
 * - an assistant `tool_use` block's `id` → the line containing the block.
 */
function buildNativeIdIndex(parsed: ParsedRawLine[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const { index: lineIndex, rec } of parsed) {
    if (typeof rec.uuid === "string" && rec.uuid.length > 0) {
      index.set(rec.uuid, lineIndex);
    }
    for (const block of contentBlocksOf(rec)) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        index.set(block.id, lineIndex);
      }
    }
  }
  return index;
}

/**
 * Parent shape of a projection: each node's parent as an index into the
 * projection (`null` = root, `-1` = parent not in the projection). Computed
 * identically at plan time (over the original lines) and at validation time
 * (over the synthesized file), where the fresh node ids cancel out.
 */
function parentIndexShape(nodes: readonly ChronoNode[]): (number | null)[] {
  const indexById = new Map<string, number>();
  nodes.forEach((n, i) => indexById.set(n.id, i));
  return nodes.map((n) => (n.parentId === null ? null : (indexById.get(n.parentId) ?? -1)));
}

/** Resolves a node's `meta.nativeUuid` to its host line. Synthetic block ids
 * of the form `<lineUuid>#<i>` resolve through their base line uuid. */
function locateLine(nativeUuid: string, index: Map<string, number>): number | undefined {
  const direct = index.get(nativeUuid);
  if (direct !== undefined) return direct;
  const hash = nativeUuid.indexOf("#");
  if (hash > 0) return index.get(nativeUuid.slice(0, hash));
  return undefined;
}

/**
 * Plans a rewind to `targetNodeId`. Pure — no filesystem access.
 *
 * Exact mode requires ALL of:
 * 1. an unbroken, acyclic ancestor chain target → root within `nodes`;
 * 2. no summary / compaction / sidechain marker line inside the chain's
 *    line range in the original transcript (compaction honesty: a chain
 *    that crosses a compaction boundary references context the transcript
 *    no longer contains verbatim, so we refuse rather than guess);
 * 3. every chain node's transcript line locatable in `rawLines`;
 * 4. the chain root's line is a TRUE transcript root — a non-null raw
 *    parentUuid resolving nowhere in the transcript (truncated file) refuses.
 *
 * Included lines are the chain's host lines PLUS, for every tool_use block
 * hosted on an included line, its tool_result's host line when that line
 * falls at or before the target's line (no mid-file dangling tool_use; a
 * dangler at the tip is native interrupted shape and stays allowed).
 */
export function planRewind(input: PlanRewindInput): ClaudeRewindPlan {
  const { nodes, targetNodeId, rawLines, projectsSubdir, sessionId } = input;

  const byId = new Map<string, ChronoNode>(nodes.map((n) => [n.id, n]));
  const target = byId.get(targetNodeId);
  if (!target) return refuse(sessionId, targetNodeId, REASON_NO_TARGET);

  // (1) Walk target → root via parentId, cycle-guarded.
  const chain: ChronoNode[] = [];
  const visited = new Set<string>();
  let current: ChronoNode = target;
  for (;;) {
    if (visited.has(current.id)) return refuse(sessionId, targetNodeId, REASON_CYCLE);
    visited.add(current.id);
    chain.push(current);
    if (current.parentId === null) break;
    const parent = byId.get(current.parentId);
    if (!parent) return refuse(sessionId, targetNodeId, REASON_ORPHAN);
    current = parent;
  }

  // (3) Locate every chain node's host line in the original transcript.
  const parsed = parseRawLines(rawLines);
  const nativeIdIndex = buildNativeIdIndex(parsed);
  const recByLineIndex = new Map<number, Record<string, unknown>>();
  for (const { index, rec } of parsed) recByLineIndex.set(index, rec);

  const lineIndexSet = new Set<number>();
  let targetLineIndex = -1;
  let rootLineIndex = -1;
  for (let c = 0; c < chain.length; c++) {
    const node = chain[c];
    const nativeUuid = node.meta?.nativeUuid ?? node.id.replace(/^claude:/, "");
    const lineIndex = locateLine(nativeUuid, nativeIdIndex);
    if (lineIndex === undefined) return refuse(sessionId, targetNodeId, REASON_MISSING_LINES);
    if (c === 0) targetLineIndex = lineIndex; // chain[0] is the target
    rootLineIndex = lineIndex; // last iteration is the chain root
    lineIndexSet.add(lineIndex);
  }

  // Root honesty: the chain root's line must be a TRUE transcript root. The
  // parser tolerates orphaned parentage by nulling parentId, but a root line
  // whose raw parentUuid is non-null and resolves nowhere in the transcript
  // means the file was truncated (or corrupted) upstream of the chain —
  // synthesizing a "root" from a mid-conversation line would fabricate
  // history the model never saw as a conversation start.
  const rootParentUuid = recByLineIndex.get(rootLineIndex)?.parentUuid;
  if (
    typeof rootParentUuid === "string" &&
    rootParentUuid.length > 0 &&
    !nativeIdIndex.has(rootParentUuid)
  ) {
    return refuse(sessionId, targetNodeId, REASON_ROOT_UNRESOLVED);
  }

  // Dangling-tool_use honesty: for every tool_use block hosted on an
  // INCLUDED line, also include its tool_result's host line — a chain
  // through one of several parallel tool_use blocks would otherwise leave a
  // MID-FILE assistant tool_use with no tool_result, a shape native
  // transcripts never contain. A required result line falling AFTER the
  // target's line is the native interrupted-turn shape (tip dangler) and
  // stays excluded. (Result host lines are user lines and host no tool_use
  // blocks themselves, so a single pass suffices.)
  const resultHostLineByToolUseId = new Map<string, number>();
  for (const { index, rec } of parsed) {
    for (const block of contentBlocksOf(rec)) {
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        !resultHostLineByToolUseId.has(block.tool_use_id)
      ) {
        resultHostLineByToolUseId.set(block.tool_use_id, index);
      }
    }
  }
  for (const { index, rec } of parsed) {
    if (!lineIndexSet.has(index)) continue;
    for (const block of contentBlocksOf(rec)) {
      if (block.type !== "tool_use" || typeof block.id !== "string") continue;
      const resultLine = resultHostLineByToolUseId.get(block.id);
      if (resultLine !== undefined && resultLine <= targetLineIndex) {
        lineIndexSet.add(resultLine);
      }
    }
  }

  const lineIndexes = [...lineIndexSet].sort((a, b) => a - b);
  const minLine = lineIndexes[0];
  const maxLine = lineIndexes[lineIndexes.length - 1];

  // (2) Compaction honesty: refuse when any boundary marker sits WITHIN the
  // chain's line range. Markers outside the range (e.g. a summary written
  // after the target's line) don't affect the reconstructed prefix.
  for (const { index, rec } of parsed) {
    if (index >= minLine && index <= maxLine && isBoundaryLine(rec)) {
      return refuse(sessionId, targetNodeId, REASON_BOUNDARY);
    }
  }

  // Chain projection: what parsing exactly these source lines yields. This
  // is computed against the ORIGINAL lines and later compared against the
  // synthesized file in executeRewind's round-trip validation.
  //
  // Truncation granularity is the LINE: when the target is a mid-line block
  // (e.g. one tool_use among several in a single assistant line), the whole
  // host line is kept — sibling blocks after the target included — because a
  // transcript line is the smallest unit Claude Code reads, and rewriting
  // message content to drop blocks would fabricate a message the model never
  // produced. Nothing AFTER the target's line is ever included.
  const projection = parseSessionJsonl(
    "chain-projection.jsonl",
    lineIndexes.map((i) => rawLines[i]).join("\n"),
  );
  if (!projection) return refuse(sessionId, targetNodeId, REASON_MISSING_LINES);

  // Pin each included line's uuid so executeRewind can verify it is reading
  // the SAME lines the plan was built from before writing anything.
  const lineUuids: string[] = [];
  for (const lineIndex of lineIndexes) {
    const uuid = recByLineIndex.get(lineIndex)?.uuid;
    if (typeof uuid !== "string" || uuid.length === 0) {
      return refuse(sessionId, targetNodeId, REASON_MISSING_LINES);
    }
    lineUuids.push(uuid);
  }

  const newSessionId = crypto.randomUUID();
  return {
    mode: "exact",
    newSessionId,
    transcriptPath: path.join(projectsSubdir, `${newSessionId}.jsonl`),
    refusedReason: null,
    resumeCommand: `claude --resume ${newSessionId}`,
    sessionId,
    targetNodeId,
    lineIndexes,
    lineUuids,
    expectedKinds: projection.nodes.map((n) => n.kind),
    expectedParentIndexes: parentIndexShape(projection.nodes),
  };
}

/**
 * Executes an exact rewind plan: writes the synthesized transcript as a NEW
 * file at `plan.transcriptPath` and validates it round-trips through
 * `parseSessionJsonl` to the plan's chain projection — node kinds, count,
 * sessionId, AND parent-index shape.
 *
 * - Tip plans are a no-op (nothing to write; the resumeCommand already
 *   points at the original session with `--fork-session`).
 * - Before anything is written, every plan line's uuid is asserted against
 *   `rawLines` (`plan.lineUuids`); drift → `plan_invalid`, no file created.
 * - The original transcript is NEVER touched: this function only receives
 *   its lines and only ever writes `plan.transcriptPath` (+ a tmp sibling).
 * - Write is atomic: content goes to a tmp file (non-.jsonl suffix, so
 *   transcript watchers ignore it) then `rename`d into place.
 * - On validation mismatch the file is deleted before throwing — a bad
 *   transcript must never be left behind for `claude --resume` to load.
 */
export async function executeRewind(
  plan: ClaudeRewindPlan,
  rawLines: string[],
): Promise<ClaudeRewindPlan> {
  if (plan.mode !== "exact") return plan;

  if (
    plan.newSessionId === null ||
    plan.transcriptPath === null ||
    plan.lineIndexes.length === 0 ||
    plan.lineUuids.length !== plan.lineIndexes.length
  ) {
    throw new SojournRewindError(
      "exact plan is missing newSessionId/transcriptPath/lineIndexes or has mismatched lineUuids",
      "plan_invalid",
    );
  }
  const { newSessionId, transcriptPath } = plan;

  // Re-parse the plan's source lines from rawLines (the same array the plan
  // was built from — indexes are the handoff contract) and assert every
  // line's uuid against the plan's pins BEFORE writing anything: a mismatch
  // means rawLines drifted since planning and the plan no longer describes
  // these lines.
  const included: Record<string, unknown>[] = [];
  for (let k = 0; k < plan.lineIndexes.length; k++) {
    const lineIndex = plan.lineIndexes[k];
    const raw = rawLines[lineIndex];
    let rec: unknown;
    try {
      rec = JSON.parse((raw ?? "").trim());
    } catch {
      rec = null;
    }
    if (typeof rec !== "object" || rec === null) {
      throw new SojournRewindError(
        `plan line index ${lineIndex} does not resolve to a JSON line in rawLines`,
        "plan_invalid",
      );
    }
    const expectedUuid = plan.lineUuids[k];
    const actualUuid = (rec as Record<string, unknown>).uuid;
    if (typeof expectedUuid !== "string" || expectedUuid.length === 0 || actualUuid !== expectedUuid) {
      throw new SojournRewindError(
        `rawLines drifted since planning: line index ${lineIndex} has uuid ${String(actualUuid)}, plan pinned ${String(expectedUuid)}`,
        "plan_invalid",
      );
    }
    included.push(rec as Record<string, unknown>);
  }

  // Collect every uuid present anywhere in the ORIGINAL transcript so the
  // fresh uuids are provably collision-free against the whole file.
  const originalUuids = new Set<string>();
  for (const { rec } of parseRawLines(rawLines)) {
    if (typeof rec.uuid === "string") originalUuids.add(rec.uuid);
    if (typeof rec.parentUuid === "string") originalUuids.add(rec.parentUuid);
  }

  // Stable old-uuid → fresh-uuid map over the included lines (every line's
  // uuid was already verified against the plan's pins above).
  const uuidMap = new Map<string, string>();
  for (const rec of included) {
    let fresh = crypto.randomUUID();
    while (originalUuids.has(fresh) || uuidMap.has(fresh)) fresh = crypto.randomUUID();
    uuidMap.set(rec.uuid as string, fresh);
  }

  // Rewrite: sessionId → newSessionId; uuid → fresh; parentUuid → the fresh
  // uuid of its original parent line when that line is included, else spliced
  // to the nearest PRECEDING included line (real transcripts chain parentUuid
  // linearly line-by-line, so excluding a sibling line — e.g. the tool_result
  // of a tool_use that isn't on the chain — leaves the next line's parentUuid
  // dangling; splicing reattaches the LINE list without altering any chain
  // node's parentage, which for tool_results resolves via tool_use_id).
  const outLines: string[] = [];
  const newUuidsInOrder: string[] = [];
  for (let k = 0; k < included.length; k++) {
    const rec = included[k];
    const rewritten: Record<string, unknown> = { ...rec };
    const freshUuid = uuidMap.get(rec.uuid as string)!;
    rewritten.uuid = freshUuid;
    rewritten.sessionId = newSessionId;
    if (k === 0) {
      rewritten.parentUuid = null;
    } else {
      const oldParent = rec.parentUuid;
      rewritten.parentUuid =
        typeof oldParent === "string" && uuidMap.has(oldParent)
          ? uuidMap.get(oldParent)!
          : newUuidsInOrder[k - 1];
    }
    newUuidsInOrder.push(freshUuid);
    outLines.push(JSON.stringify(rewritten));
  }
  const content = outLines.join("\n") + "\n";

  // NEW files only: never clobber an existing transcript.
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const alreadyExists = await fs.access(transcriptPath).then(
    () => true,
    () => false,
  );
  if (alreadyExists) {
    throw new SojournRewindError(
      `refusing to overwrite existing transcript at ${transcriptPath}`,
      "transcript_exists",
    );
  }

  // Atomic write: tmp + rename (same directory, non-.jsonl suffix).
  const tmpPath = `${transcriptPath}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, transcriptPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw new SojournRewindError(
      `failed to write synthesized transcript: ${err instanceof Error ? err.message : String(err)}`,
      "write_failed",
    );
  }

  // Round-trip validation against the WRITTEN bytes: the synthesized file
  // must project to exactly the plan's chain projection. On mismatch the
  // file is deleted — never leave a bad transcript behind.
  let failure: string | null = null;
  try {
    const written = await fs.readFile(transcriptPath, "utf8");
    const batch = parseSessionJsonl(transcriptPath, written);
    if (!batch) {
      failure = "synthesized transcript parsed to zero nodes";
    } else if (batch.session.id !== newSessionId) {
      failure = `synthesized transcript sessionId ${batch.session.id} != ${newSessionId}`;
    } else if (batch.nodes.length !== plan.expectedKinds.length) {
      failure = `synthesized transcript projects ${batch.nodes.length} nodes, expected ${plan.expectedKinds.length}`;
    } else {
      // Kinds AND parent shape: parentUuid is exactly what the rewrite
      // touches, so validation must prove the projected TREE survived, not
      // just the node kinds/count.
      const shape = parentIndexShape(batch.nodes);
      for (let i = 0; i < batch.nodes.length; i++) {
        if (batch.nodes[i].kind !== plan.expectedKinds[i]) {
          failure = `node ${i} kind ${batch.nodes[i].kind} != expected ${plan.expectedKinds[i]}`;
          break;
        }
        if (shape[i] !== plan.expectedParentIndexes[i]) {
          failure = `node ${i} parent index ${String(shape[i])} != expected ${String(plan.expectedParentIndexes[i])}`;
          break;
        }
      }
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  if (failure !== null) {
    await fs.rm(transcriptPath, { force: true });
    throw new SojournRewindError(
      `synthesized transcript failed round-trip validation (${failure}); file deleted`,
      "validation_mismatch",
    );
  }

  // Provenance sidecar (V2 must-fix I3): written LAST, same atomic tmp +
  // rename pattern, non-.jsonl so transcript watchers never ingest it. The
  // pair is all-or-nothing — a synthesized transcript WITHOUT its sidecar
  // would be exactly the disconnected, false-flag-prone phantom session the
  // sidecar exists to prevent, so a failed sidecar write deletes the
  // transcript and fails the rewind typed rather than leaving the phantom.
  const sidecar: RewindSidecar = {
    originSessionId: plan.sessionId,
    originNodeId: plan.targetNodeId,
    lineUuids: newUuidsInOrder,
  };
  const sidecarPath = rewindSidecarPathFor(transcriptPath);
  const sidecarTmp = `${sidecarPath}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(sidecarTmp, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    await fs.rename(sidecarTmp, sidecarPath);
  } catch (err) {
    await fs.rm(sidecarTmp, { force: true }).catch(() => {});
    await fs.rm(transcriptPath, { force: true }).catch(() => {});
    throw new SojournRewindError(
      `failed to write rewind provenance sidecar: ${err instanceof Error ? err.message : String(err)}; transcript deleted`,
      "write_failed",
    );
  }

  return plan;
}
