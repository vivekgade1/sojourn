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
 * mutates an existing transcript, and refusing — `transcript_exists` /
 * `sidecar_exists` — rather than clobbering either member of the pair),
 * writes atomically (tmp + rename), and round-trip-validates the synthesized
 * transcript through the same parser that produced the graph — deleting BOTH
 * files and throwing if the projection doesn't match the plan.
 *
 * Write ORDER is load-bearing: the provenance sidecar is written and renamed
 * into place FIRST, the transcript second. The daemon's watcher only reacts
 * to `.jsonl`, so by the time a transcript can be observed its sidecar is
 * already durable. A crash in the window between the two renames leaves at
 * worst an ORPHAN SIDECAR — inert (nothing ingests a `.json`) and reclaimable
 * by a gc sweep via `listRewindSidecars` — instead of the far worse orphan
 * TRANSCRIPT, which the watcher would ingest as a disconnected phantom
 * session carrying false verified flags (V2 must-fix I3).
 */

/** Stable machine-readable classification for a `SojournRewindError`. */
export type SojournRewindErrorCode =
  | "plan_invalid"
  | "transcript_exists"
  | "sidecar_exists"
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

const SIDECAR_SUFFIX = ".sojourn-rewind.json";

/**
 * How a `<sessionId>.jsonl` / `<sessionId>.sojourn-rewind.json` pair actually
 * sits on disk:
 *
 * - `paired` — both present, sidecar parsed: a healthy synthesized rewind.
 * - `orphan_sidecar` — sidecar present, transcript missing. This is the ONLY
 *   residue a crash mid-`executeRewind` can leave now that the sidecar is
 *   written first, and it is inert: nothing ingests a `.json`. It is exactly
 *   what a `soj gc` retention sweep should reclaim.
 * - `unreadable_sidecar` — a `*.sojourn-rewind.json` that could not be read or
 *   did not parse to the `RewindSidecar` shape. Reported, never thrown on;
 *   `sidecar` is null. A gc sweep should treat these conservatively (a
 *   half-written file is not proof the transcript is unowned).
 * - `orphan_transcript` — a `.jsonl` with no sibling sidecar. For a
 *   SYNTHESIZED transcript this is expected to be IMPOSSIBLE, because the
 *   sidecar is renamed into place before the transcript exists at all. In a
 *   real projects dir it is therefore the ordinary case: every native Claude
 *   Code session is an `orphan_transcript`. Callers MUST NOT read this status
 *   as garbage — it means "not a rewind", not "broken".
 */
export type RewindSidecarPairStatus =
  | "paired"
  | "orphan_sidecar"
  | "orphan_transcript"
  | "unreadable_sidecar";

/** One `<sessionId>` pair found by `listRewindSidecars`. */
export interface RewindSidecarEntry {
  /** The sibling transcript path, whether or not it exists on disk. */
  transcriptPath: string;
  /** The sibling sidecar path, whether or not it exists on disk. */
  sidecarPath: string;
  status: RewindSidecarPairStatus;
  /** Parsed sidecar; null unless `status === "paired"` or `"orphan_sidecar"`. */
  sidecar: RewindSidecar | null;
}

/** Structural validation — mirrors the daemon ingest's acceptance check. */
function asRewindSidecar(value: unknown): RewindSidecar | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.originSessionId !== "string" || rec.originSessionId.length === 0) return null;
  if (typeof rec.originNodeId !== "string" || rec.originNodeId.length === 0) return null;
  if (!Array.isArray(rec.lineUuids)) return null;
  if (!rec.lineUuids.every((u) => typeof u === "string")) return null;
  return {
    originSessionId: rec.originSessionId,
    originNodeId: rec.originNodeId,
    lineUuids: rec.lineUuids as string[],
  };
}

/**
 * Enumerates every rewind sidecar AND every transcript in a Claude projects
 * subdirectory, pairing them by session id so a caller (the future `soj gc`
 * retention sweep) can see both directions of breakage — see
 * `RewindSidecarPairStatus` for what each direction means and which one is
 * structurally impossible.
 *
 * Fails soft everywhere: a missing/unreadable directory yields `[]`, and an
 * unreadable or malformed sidecar becomes an `unreadable_sidecar` entry rather
 * than an exception. Results are sorted by `transcriptPath` for determinism.
 */
export async function listRewindSidecars(
  projectsSubdir: string,
): Promise<RewindSidecarEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(projectsSubdir);
  } catch {
    return [];
  }

  const sidecarBases = new Set<string>();
  const transcriptBases = new Set<string>();
  for (const name of names) {
    if (name.endsWith(SIDECAR_SUFFIX)) {
      sidecarBases.add(name.slice(0, -SIDECAR_SUFFIX.length));
    } else if (name.endsWith(".jsonl")) {
      transcriptBases.add(name.slice(0, -".jsonl".length));
    }
  }

  const entries: RewindSidecarEntry[] = [];
  for (const base of new Set([...sidecarBases, ...transcriptBases])) {
    const transcriptPath = path.join(projectsSubdir, `${base}.jsonl`);
    const sidecarPath = path.join(projectsSubdir, `${base}${SIDECAR_SUFFIX}`);
    const hasTranscript = transcriptBases.has(base);

    if (!sidecarBases.has(base)) {
      entries.push({ transcriptPath, sidecarPath, status: "orphan_transcript", sidecar: null });
      continue;
    }

    let sidecar: RewindSidecar | null = null;
    try {
      sidecar = asRewindSidecar(JSON.parse(await fs.readFile(sidecarPath, "utf8")));
    } catch {
      sidecar = null;
    }
    if (sidecar === null) {
      entries.push({ transcriptPath, sidecarPath, status: "unreadable_sidecar", sidecar: null });
      continue;
    }
    entries.push({
      transcriptPath,
      sidecarPath,
      status: hasTranscript ? "paired" : "orphan_sidecar",
      sidecar,
    });
  }

  entries.sort((a, b) => (a.transcriptPath < b.transcriptPath ? -1 : a.transcriptPath > b.transcriptPath ? 1 : 0));
  return entries;
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

/** Every tool BLOCK id referenced by a record — both the `tool_use.id` that
 * DEFINES a tool node and the `tool_result.tool_use_id` that REFERS to one.
 * Collected together because they must be remapped through the same map or
 * the tool_result -> tool_use parent edge is severed. */
function toolIdsIn(rec: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const block of contentBlocksOf(rec)) {
    if (block.type === "tool_use" && typeof block.id === "string") {
      ids.push(block.id);
    } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      ids.push(block.tool_use_id);
    }
  }
  return ids;
}

/** A fresh tool block id. Keeps Claude's `toolu_` prefix so a synthesized
 * transcript stays visually indistinguishable from a native one; the parser
 * treats the id as an opaque key, so only uniqueness is load-bearing. */
function freshToolId(): string {
  return `toolu_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** Returns a copy of `rec` with every tool block id replaced via `toolIdMap`.
 * Deep-copies `message.content` (and each block) so the caller's records are
 * never mutated — the rewrite path spreads records shallowly. Ids absent from
 * the map are left alone. */
function remapToolIds(
  rec: Record<string, unknown>,
  toolIdMap: Map<string, string>,
): Record<string, unknown> {
  const message = rec.message;
  if (typeof message !== "object" || message === null) return rec;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return rec;

  const remapped = content.map((block) => {
    if (typeof block !== "object" || block === null) return block;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use" && typeof b.id === "string" && toolIdMap.has(b.id)) {
      return { ...b, id: toolIdMap.get(b.id)! };
    }
    if (
      b.type === "tool_result" &&
      typeof b.tool_use_id === "string" &&
      toolIdMap.has(b.tool_use_id)
    ) {
      return { ...b, tool_use_id: toolIdMap.get(b.tool_use_id)! };
    }
    return b;
  });

  return { ...rec, message: { ...(message as Record<string, unknown>), content: remapped } };
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
 * - Each write is atomic: content goes to a tmp file (non-.jsonl suffix, so
 *   transcript watchers ignore it) then `rename`d into place.
 * - The provenance SIDECAR is renamed into place BEFORE the transcript, so no
 *   observable `.jsonl` ever exists without its provenance. A crash between
 *   the two renames leaves only an inert orphan sidecar (see the module
 *   docblock and `listRewindSidecars`).
 * - On transcript write failure or validation mismatch BOTH files are deleted
 *   before throwing — a bad transcript must never be left behind for
 *   `claude --resume` to load, and its now-pointless sidecar must not become
 *   garbage a gc sweep has to reason about. Cleanup is best-effort and never
 *   masks the original typed error.
 * - `deps.fs` is an optional injection seam (defaults to `node:fs/promises`)
 *   used by tests to assert write ORDER and simulate a crash deterministically;
 *   production callers pass two positional args as before.
 */
export type RewindFs = Pick<
  typeof fs,
  "writeFile" | "rename" | "rm" | "mkdir" | "access" | "readFile"
>;

export interface ExecuteRewindDeps {
  fs?: Partial<RewindFs>;
}

export async function executeRewind(
  plan: ClaudeRewindPlan,
  rawLines: string[],
  deps?: ExecuteRewindDeps,
): Promise<ClaudeRewindPlan> {
  if (plan.mode !== "exact") return plan;

  const io: RewindFs = {
    writeFile: fs.writeFile,
    rename: fs.rename,
    rm: fs.rm,
    mkdir: fs.mkdir,
    access: fs.access,
    readFile: fs.readFile,
    ...deps?.fs,
  };
  /** Cleanup must never mask the typed error that triggered it. */
  const bestEffortRm = async (target: string): Promise<void> => {
    try {
      await io.rm(target, { force: true });
    } catch {
      // ignore
    }
  };

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

  // Tool BLOCK ids must be freshened too, and this is load-bearing for graph
  // integrity — not cosmetic.
  //
  // The parser keys tool nodes on the tool_use block id, NOT the line uuid
  // (parser.ts: `nativeUuid: block.id` -> `id: nodeIdFor(nativeUuid)`). So a
  // synthesized transcript that reuses block ids projects tool nodes whose ids
  // collide with the ORIGIN session's, and the store's upsert MOVES them onto
  // the new session: the origin loses its own tool nodes, its ancestor chains
  // break, and a later exact rewind of the origin is then falsely refused with
  // "ancestor chain incomplete (orphaned parentage)".
  //
  // Both sides of the pair are remapped through ONE map so the projected tree
  // is preserved: a tool_result resolves its parent via `tool_use_id`
  // (parser.ts), so remapping tool_use.id without its referring tool_result
  // would sever that edge. Round-trip validation below compares kinds and
  // parent-index SHAPE positionally, never ids, so a consistent remap passes.
  const originalToolIds = new Set<string>();
  for (const { rec } of parseRawLines(rawLines)) {
    for (const id of toolIdsIn(rec)) originalToolIds.add(id);
  }
  const toolIdMap = new Map<string, string>();
  for (const rec of included) {
    for (const id of toolIdsIn(rec)) {
      if (toolIdMap.has(id)) continue;
      let fresh = freshToolId();
      while (originalToolIds.has(fresh) || toolIdMap.has(fresh)) fresh = freshToolId();
      toolIdMap.set(id, fresh);
    }
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
    // remapToolIds deep-copies the message content before touching it: the
    // spread below is SHALLOW, so mutating nested blocks in place would
    // corrupt the caller's parsed records (and, via `included`, the very
    // objects a later iteration reads).
    const rewritten: Record<string, unknown> = { ...remapToolIds(rec, toolIdMap) };
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

  // NEW files only — for BOTH members of the pair. `mkdir` first: the sidecar
  // and the transcript are siblings and both need the directory.
  await io.mkdir(path.dirname(transcriptPath), { recursive: true });
  const sidecarPath = rewindSidecarPathFor(transcriptPath);
  const exists = async (target: string): Promise<boolean> =>
    io.access(target).then(
      () => true,
      () => false,
    );
  if (await exists(transcriptPath)) {
    throw new SojournRewindError(
      `refusing to overwrite existing transcript at ${transcriptPath}`,
      "transcript_exists",
    );
  }
  if (await exists(sidecarPath)) {
    throw new SojournRewindError(
      `refusing to overwrite existing rewind provenance sidecar at ${sidecarPath}`,
      "sidecar_exists",
    );
  }

  // Provenance sidecar (V2 must-fix I3): written FIRST, atomic tmp + rename,
  // non-.jsonl so transcript watchers never ingest it. The pair is
  // all-or-nothing, and the ORDER decides which way a crash can break it. A
  // synthesized transcript WITHOUT its sidecar is the disconnected,
  // false-flag-prone phantom session the sidecar exists to prevent — so the
  // sidecar goes down first and the transcript, the only file a watcher
  // reacts to, appears last. Every field is known here: the transcript path
  // and session id were minted at plan time and the synthesized line uuids
  // were finalized by the rewrite loop above, so this is a single complete
  // write — never a placeholder to be filled in later. (An empty-`lineUuids`
  // placeholder would VALIDATE in the daemon's ingest and yield an empty T1
  // skip set, reintroducing exactly the false-verified-flag bug I3 fixed.)
  const sidecar: RewindSidecar = {
    originSessionId: plan.sessionId,
    originNodeId: plan.targetNodeId,
    lineUuids: newUuidsInOrder,
  };
  const sidecarTmp = `${sidecarPath}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await io.writeFile(sidecarTmp, JSON.stringify(sidecar, null, 2) + "\n", "utf8");
    await io.rename(sidecarTmp, sidecarPath);
  } catch (err) {
    await bestEffortRm(sidecarTmp);
    throw new SojournRewindError(
      `failed to write rewind provenance sidecar: ${err instanceof Error ? err.message : String(err)}`,
      "write_failed",
    );
  }

  // Atomic write: tmp + rename (same directory, non-.jsonl suffix).
  const tmpPath = `${transcriptPath}.tmp-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await io.writeFile(tmpPath, content, "utf8");
    await io.rename(tmpPath, transcriptPath);
  } catch (err) {
    // Inverted cleanup: the sidecar is now the file that already landed, and
    // an orphan sidecar is precisely the garbage a gc sweep would have to
    // reason about. Take both down.
    await bestEffortRm(tmpPath);
    await bestEffortRm(sidecarPath);
    throw new SojournRewindError(
      `failed to write synthesized transcript: ${err instanceof Error ? err.message : String(err)}`,
      "write_failed",
    );
  }

  // Round-trip validation against the WRITTEN bytes: the synthesized file
  // must project to exactly the plan's chain projection. On mismatch BOTH
  // files are deleted — never leave a bad transcript behind, and never leave
  // its sidecar behind to be reclaimed later.
  let failure: string | null = null;
  try {
    const written = await io.readFile(transcriptPath, "utf8");
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
    await bestEffortRm(transcriptPath);
    await bestEffortRm(sidecarPath);
    throw new SojournRewindError(
      `synthesized transcript failed round-trip validation (${failure}); transcript and sidecar deleted`,
      "validation_mismatch",
    );
  }

  return plan;
}
