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
 *   from, ascending — the chain's source lines, ending at the target's line.
 * - `expectedKinds`: the chain projection — the node kinds (in parse order)
 *   that parsing exactly those source lines yields. Used by execute's
 *   round-trip validation.
 * - `sessionId`: the ORIGINAL session id (rewritten to `newSessionId` in the
 *   synthesized file).
 */
export interface ClaudeRewindPlan extends RewindPlan {
  sessionId: string;
  lineIndexes: number[];
  expectedKinds: NodeKind[];
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

function refuse(sessionId: string, reason: string): ClaudeRewindPlan {
  return {
    mode: "tip",
    newSessionId: null,
    transcriptPath: null,
    refusedReason: reason,
    resumeCommand: `claude --resume ${sessionId} --fork-session`,
    sessionId,
    lineIndexes: [],
    expectedKinds: [],
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
    const message = rec.message;
    if (typeof message === "object" && message !== null) {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "tool_use" &&
            typeof (block as Record<string, unknown>).id === "string"
          ) {
            index.set((block as Record<string, unknown>).id as string, lineIndex);
          }
        }
      }
    }
  }
  return index;
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
 * 3. every chain node's transcript line locatable in `rawLines`.
 */
export function planRewind(input: PlanRewindInput): ClaudeRewindPlan {
  const { nodes, targetNodeId, rawLines, projectsSubdir, sessionId } = input;

  const byId = new Map<string, ChronoNode>(nodes.map((n) => [n.id, n]));
  const target = byId.get(targetNodeId);
  if (!target) return refuse(sessionId, REASON_NO_TARGET);

  // (1) Walk target → root via parentId, cycle-guarded.
  const chain: ChronoNode[] = [];
  const visited = new Set<string>();
  let current: ChronoNode = target;
  for (;;) {
    if (visited.has(current.id)) return refuse(sessionId, REASON_CYCLE);
    visited.add(current.id);
    chain.push(current);
    if (current.parentId === null) break;
    const parent = byId.get(current.parentId);
    if (!parent) return refuse(sessionId, REASON_ORPHAN);
    current = parent;
  }

  // (3) Locate every chain node's host line in the original transcript.
  const parsed = parseRawLines(rawLines);
  const nativeIdIndex = buildNativeIdIndex(parsed);
  const lineIndexSet = new Set<number>();
  for (const node of chain) {
    const nativeUuid = node.meta?.nativeUuid ?? node.id.replace(/^claude:/, "");
    const lineIndex = locateLine(nativeUuid, nativeIdIndex);
    if (lineIndex === undefined) return refuse(sessionId, REASON_MISSING_LINES);
    lineIndexSet.add(lineIndex);
  }
  const lineIndexes = [...lineIndexSet].sort((a, b) => a - b);
  const minLine = lineIndexes[0];
  const maxLine = lineIndexes[lineIndexes.length - 1];

  // (2) Compaction honesty: refuse when any boundary marker sits WITHIN the
  // chain's line range. Markers outside the range (e.g. a summary written
  // after the target's line) don't affect the reconstructed prefix.
  for (const { index, rec } of parsed) {
    if (index >= minLine && index <= maxLine && isBoundaryLine(rec)) {
      return refuse(sessionId, REASON_BOUNDARY);
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
  if (!projection) return refuse(sessionId, REASON_MISSING_LINES);

  const newSessionId = crypto.randomUUID();
  return {
    mode: "exact",
    newSessionId,
    transcriptPath: path.join(projectsSubdir, `${newSessionId}.jsonl`),
    refusedReason: null,
    resumeCommand: `claude --resume ${newSessionId}`,
    sessionId,
    lineIndexes,
    expectedKinds: projection.nodes.map((n) => n.kind),
  };
}

/**
 * Executes an exact rewind plan: writes the synthesized transcript as a NEW
 * file at `plan.transcriptPath` and validates it round-trips through
 * `parseSessionJsonl` to the plan's chain projection.
 *
 * - Tip plans are a no-op (nothing to write; the resumeCommand already
 *   points at the original session with `--fork-session`).
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

  if (plan.newSessionId === null || plan.transcriptPath === null || plan.lineIndexes.length === 0) {
    throw new SojournRewindError(
      "exact plan is missing newSessionId/transcriptPath/lineIndexes",
      "plan_invalid",
    );
  }
  const { newSessionId, transcriptPath } = plan;

  // Re-parse the plan's source lines from rawLines (the same array the plan
  // was built from — indexes are the handoff contract).
  const included: Record<string, unknown>[] = [];
  for (const lineIndex of plan.lineIndexes) {
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
    included.push(rec as Record<string, unknown>);
  }

  // Collect every uuid present anywhere in the ORIGINAL transcript so the
  // fresh uuids are provably collision-free against the whole file.
  const originalUuids = new Set<string>();
  for (const { rec } of parseRawLines(rawLines)) {
    if (typeof rec.uuid === "string") originalUuids.add(rec.uuid);
    if (typeof rec.parentUuid === "string") originalUuids.add(rec.parentUuid);
  }

  // Stable old-uuid → fresh-uuid map over the included lines.
  const uuidMap = new Map<string, string>();
  for (const rec of included) {
    if (typeof rec.uuid !== "string" || rec.uuid.length === 0) {
      throw new SojournRewindError(
        "an included transcript line has no uuid; cannot remap",
        "plan_invalid",
      );
    }
    let fresh = crypto.randomUUID();
    while (originalUuids.has(fresh) || uuidMap.has(fresh)) fresh = crypto.randomUUID();
    uuidMap.set(rec.uuid, fresh);
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
      for (let i = 0; i < batch.nodes.length; i++) {
        if (batch.nodes[i].kind !== plan.expectedKinds[i]) {
          failure = `node ${i} kind ${batch.nodes[i].kind} != expected ${plan.expectedKinds[i]}`;
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

  return plan;
}
