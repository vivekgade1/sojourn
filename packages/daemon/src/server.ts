import { logError } from "./logger.js";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type {
  ChronoNode,
  CheckContext,
  CriticLLM,
  FlagEngine,
  GraphStore,
  HarvestDeps,
  NodeKind,
  Project,
  RestoreEngine,
  RewindPlan,
  SnapshotterLike,
  StoredFlag,
} from "@sojourn/core";
import {
  applyBudgets,
  getSessionHealth,
  harvest as coreHarvest,
  harvestPreflight as coreHarvestPreflight,
  runCritic,
  SojournHarvestError,
  SojournRestoreError,
} from "@sojourn/core";
import { executeRewind, planRewind, SojournRewindError } from "@sojourn/adapter-claude";
import type { ClaudeRewindPlan } from "@sojourn/adapter-claude";
import { readRestoreManifest, resolveTurnBaseTree, type EventsSink } from "./ingest.js";
import type { FetchJson } from "@sojourn/core";
import type { TranscriptIndexLike } from "./transcripts.js";
import { anthropicCritic } from "./critic.js";

export interface ServerDeps {
  store: GraphStore;
  snapshotterFor(project: Project): SnapshotterLike;
  flagEngine: FlagEngine;
  restoreEngine: RestoreEngine;
  events: EventsSink;
  version: string;
  fetchJson?: FetchJson;
  /**
   * Builds the Tier-2 critic LLM client from an API key. Injected so tests
   * can supply a fake `CriticLLM` and never touch the network; defaults to
   * the real Anthropic Messages API client.
   */
  criticFor?: (apiKey: string) => CriticLLM;
  /**
   * Re-scans a Claude transcript file immediately (used by
   * POST /api/hooks/claude). Injected so tests can assert it was called
   * without touching the real filesystem watcher.
   */
  rescanClaudeTranscript?: (transcriptPath: string) => Promise<void> | void;
  /**
   * Re-scans an OpenCode session immediately (used by
   * POST /api/hooks/opencode): pulls the session + messages from the local
   * OpenCode server and ingests them. Fire-and-forget and fail-soft — the
   * route 200s regardless. Injected so tests can wire a stub OpenCode
   * server (or assert the call) without a live OpenCode install.
   */
  rescanOpenCodeSession?: (sessionId: string) => Promise<void> | void;
  /**
   * Session -> transcript-location index maintained by the transcript
   * scanners (see transcripts.ts). Powers the rewind routes (raw transcript
   * lines) and worktree-aliased flag runs (the session's actual disk root).
   * Optional: without it, rewind routes 404 ("transcript not known") and
   * flag runs use the project's own root.
   */
  transcripts?: TranscriptIndexLike;
  /**
   * Harvest engine entry points. Injected so tests can exercise the route's
   * typed error mapping (partial_apply/mainline_drift payloads) without
   * staging a real mid-apply failure; defaults to @sojourn/core's real
   * harvest/harvestPreflight.
   */
  harvestEngine?: {
    preflight: typeof coreHarvestPreflight;
    harvest: typeof coreHarvest;
  };
}

/** Decodes a `:id` route param — node ids contain `:` (e.g. `claude:uuid`)
 * and always arrive URL-encoded. */
function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function defaultFetchJson(): FetchJson {
  return async (url: string) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timeout);
    }
  };
}

/** Resolves the built web app's `dist` directory via `@sojourn/web`'s own
 * package.json (through `createRequire`), tolerating its absence entirely
 * (no web build yet, or package not installed). */
function resolveWebDist(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@sojourn/web/package.json");
    const dist = path.join(path.dirname(pkgPath), "dist");
    if (fs.existsSync(dist)) return dist;
    return null;
  } catch {
    return null;
  }
}

/**
 * The disk root ground-truth checks should read for `node`. Normally the
 * project's own root — EXCEPT for worktree-aliased sessions (V2 Task 7):
 * those are stored under the ORIGIN project but actually ran inside a
 * restored worktree, so disk-reading checks (e.g. package-hallucination's
 * node_modules probe) must look at the worktree, not the mainline. The
 * divergent root is only trusted when the transcript index reports it AND
 * the restore manifest is actually present there, resolving back into this
 * same project — the same evidence ingest used to alias the session.
 */
function resolveNodeDiskRoot(deps: ServerDeps, node: ChronoNode, project: Project): string {
  const rec = deps.transcripts?.get(node.sessionId);
  if (!rec || !rec.diskRoot) return project.root;
  if (path.resolve(rec.diskRoot) === path.resolve(project.root)) return project.root;

  const manifest = readRestoreManifest(rec.diskRoot);
  if (!manifest) return project.root;
  const origin = deps.store.getNode(manifest.nodeId);
  if (!origin || origin.projectId !== project.id) return project.root;
  return rec.diskRoot;
}

/** Builds the same `CheckContext` shape used by both the T1 deterministic
 * checks and the T2 advisory critic — TURN-scoped diff (snapshot before the
 * node's turn prompt -> node snapshot, see `resolveTurnBaseTree`),
 * session-scoped prior nodes, and the injected snapshotter/fetchJson. */
async function buildCheckContext(
  deps: ServerDeps,
  fetchJson: FetchJson,
  node: ChronoNode,
): Promise<CheckContext> {
  const project = deps.store.getProject(node.projectId);
  const sessionNodes = deps.store.getSessionNodes(node.sessionId);
  const parentTree =
    node.kind === "assistant"
      ? resolveTurnBaseTree(deps.store, node)
      : findParentSnapshotRef(deps.store, node);
  const nodeTree = node.snapshotRef;

  // Worktree-aliased nodes: run checks against the session's ACTUAL disk
  // root. The snapshotter keeps the origin project's id (shared shadow
  // object DB, so tree reads/diffs stay valid) but pins the aliased root.
  const diskRoot = project ? resolveNodeDiskRoot(deps, node, project) : "";

  let diff: Awaited<ReturnType<SnapshotterLike["diff"]>> = [];
  let snapshotter: SnapshotterLike | null = null;
  if (project && nodeTree !== null) {
    try {
      snapshotter = deps.snapshotterFor(
        diskRoot === project.root ? project : { ...project, root: diskRoot },
      );
      diff = await snapshotter.diff(parentTree, nodeTree);
    } catch (err) {
      logError("[sojourn] flags/run: diff failed:", err);
    }
  }

  return {
    node,
    priorNodes: sessionNodes,
    diff,
    parentTree,
    nodeTree,
    projectRoot: diskRoot,
    snapshotter,
    fetchJson,
  };
}

/** The daemon-facing (public) subset of a rewind plan — internal synthesis
 * fields (line indexes/uuids, projections) never leave the process. */
function publicRewindPlan(plan: RewindPlan): RewindPlan {
  return {
    mode: plan.mode,
    newSessionId: plan.newSessionId,
    transcriptPath: plan.transcriptPath,
    refusedReason: plan.refusedReason,
    resumeCommand: plan.resumeCommand,
  };
}

type PlannedRewind =
  | { ok: true; plan: ClaudeRewindPlan; rawLines: string[] }
  | { ok: false; status: number; error: string };

/**
 * Loads the node's session transcript (via the transcript index) and plans
 * a rewind to it — ALWAYS server-side, from a single file read whose lines
 * feed both the plan and (for the rewind route) the execute step. Client
 * bodies are never consulted: a POSTed "plan" is ignored by design.
 */
async function planNodeRewind(deps: ServerDeps, node: ChronoNode): Promise<PlannedRewind> {
  const rec = deps.transcripts?.get(node.sessionId);
  if (!rec) {
    return {
      ok: false,
      status: 404,
      error:
        `No transcript known for session ${node.sessionId} — the daemon has not ` +
        `seen this session's transcript file yet`,
    };
  }

  let raw: string;
  try {
    raw = await fsp.readFile(rec.transcriptPath, "utf8");
  } catch {
    return {
      ok: false,
      status: 404,
      error: `Transcript for session ${node.sessionId} could not be read at ${rec.transcriptPath}`,
    };
  }

  const rawLines = raw.split("\n");
  const plan = planRewind({
    nodes: deps.store.getSessionNodes(node.sessionId),
    targetNodeId: node.id,
    rawLines,
    projectsSubdir: path.dirname(rec.transcriptPath),
    sessionId: node.sessionId,
  });
  return { ok: true, plan, rawLines };
}

/**
 * Best-effort exact-conversation companion for a successful filesystem
 * restore: plans (and, when exact, executes) a rewind for the restored
 * node. Returns null — never throws — when the node isn't a claude node,
 * the transcript isn't known/readable, or the rewind itself fails: a
 * completed restore must never be turned into an error by its companion.
 */
async function maybeRewindForRestore(deps: ServerDeps, nodeId: string): Promise<RewindPlan | null> {
  try {
    const node = deps.store.getNode(nodeId);
    if (!node || node.cli !== "claude") return null;
    const planned = await planNodeRewind(deps, node);
    if (!planned.ok) return null;
    const executed = await executeRewind(planned.plan, planned.rawLines);
    return publicRewindPlan(executed);
  } catch (err) {
    logError(`[sojourn] restore: rewind companion failed for node ${nodeId}:`, err);
    return null;
  }
}

const THINNED_SNAPSHOT_PHRASE = "snapshot missing or thinned by retention policy (soj gc)";

const TURN_FLAG_LINE_MAX = 3;
const TURN_FLAG_LINE_CHAR_MAX = 200;

/** One compact line per flag: kind + whitespace-collapsed evidence, with a
 * digest's suppressed count surfaced explicitly. */
function formatFlagLine(flag: StoredFlag): string {
  const evidence = flag.evidence.replace(/\s+/g, " ").trim();
  const suffix =
    (flag.suppressedCount ?? 0) > 0 ? ` [+${flag.suppressedCount} similar suppressed]` : "";
  const line = `${flag.kind}: ${evidence}${suffix}`;
  return line.length > TURN_FLAG_LINE_CHAR_MAX
    ? `${line.slice(0, TURN_FLAG_LINE_CHAR_MAX - 1)}…`
    : line;
}

type HarvestContext =
  | { ok: true; mainlineRoot: string; harvestDeps: HarvestDeps }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Resolves a harvest request's mainline root + snapshotter factory from the
 * worktree's restore manifest: manifest nodeId -> origin node -> origin
 * project. `snapshotterForRoot` hands out snapshotters keyed to the ORIGIN
 * project's id with the requested root (wire.ts's id::root cache), so the
 * worktree's branch tree, the manifest's base tree, and the mainline safety
 * snapshot all live in one shadow object database.
 */
function resolveHarvestContext(deps: ServerDeps, worktreePath: string): HarvestContext {
  const manifest = readRestoreManifest(worktreePath);
  if (!manifest) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          `No valid .sojourn-restore.json manifest found in ${worktreePath} — ` +
          `not a Sojourn restore worktree.`,
        code: "no_manifest",
      },
    };
  }

  const originNode = deps.store.getNode(manifest.nodeId);
  if (!originNode) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Restore manifest in ${worktreePath} references unknown node ${manifest.nodeId}.`,
        code: "no_manifest",
      },
    };
  }

  const originProject = deps.store.getProject(originNode.projectId);
  if (!originProject) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          `Restore manifest in ${worktreePath} references node ${manifest.nodeId} whose ` +
          `project ${originNode.projectId} no longer exists.`,
        code: "no_manifest",
      },
    };
  }

  return {
    ok: true,
    mainlineRoot: originProject.root,
    harvestDeps: {
      snapshotterForRoot: (root: string) =>
        deps.snapshotterFor(
          path.resolve(root) === path.resolve(originProject.root)
            ? originProject
            : { ...originProject, root: path.resolve(root) },
        ),
      store: deps.store,
    },
  };
}

/** Typed error mapping for the harvest routes: 400 for pre-write refusals
 * (no_manifest/stale_base/conflicts/patch_incomplete), 500 — with the
 * honest `.partial` payload — for mid-apply failures. */
function handleHarvestError(err: unknown, res: Response): void {
  if (err instanceof SojournHarvestError) {
    const body: Record<string, unknown> = {
      error: err.message,
      code: err.code,
      files: err.files,
    };
    if (err.partial) body.partial = err.partial;
    const status = err.code === "partial_apply" || err.code === "mainline_drift" ? 500 : 400;
    if (status >= 500) {
      logError("[sojourn] harvest failed mid-apply:", err);
    }
    res.status(status).json(body);
    return;
  }
  logError("[sojourn] harvest route failed:", err);
  res.status(500).json({ error: "Internal error" });
}

export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json());

  const fetchJson = deps.fetchJson ?? defaultFetchJson();
  const criticFor = deps.criticFor ?? anthropicCritic;

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, version: deps.version });
  });

  app.get("/api/projects", (_req: Request, res: Response) => {
    res.json(deps.store.getProjects());
  });

  app.get("/api/projects/:id/graph", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    try {
      const project = deps.store.getProject(id);
      if (!project) {
        res.status(404).json({ error: `Project not found: ${id}` });
        return;
      }
      const sessions = deps.store.getSessions(id);
      const nodes = deps.store.getGraph(id);

      // Each node carries `restorable` — whether the restore button should be
      // live — computed SCALE-SAFELY over the in-memory `nodes` array (this is
      // the exact route the O(n^2) ingest-OOM fix, commit d22b490, was about:
      // it is hit on every page load AND every websocket reconnect). No
      // per-node store round-trip, no per-node git call: see computeRestorable.
      // computeRestorable never throws — it fails open internally — so the
      // graph always renders even if the shadow git repo is momentarily
      // unavailable (preflight remains the hard gate before any checkout).
      const restorable = await computeRestorable(deps, project, nodes);

      res.json({
        project,
        sessions,
        nodes: nodes.map((n) => ({ ...n, restorable: restorable.get(n.id) ?? false })),
      });
    } catch (err) {
      // The route is async, and Express 4 does NOT forward async-handler
      // rejections to the error middleware — an unguarded throw here (e.g.
      // JSON.parse of a row corrupted by a crash mid-write) would HANG the
      // hottest route in the app. Match the file's other async routes: 500 JSON.
      logError(`[sojourn] graph route failed for project ${id}:`, err);
      res.status(500).json({ error: "Failed to load project graph" });
    }
  });

  app.get("/api/nodes/:id", (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const node = deps.store.getNode(id);
    if (!node) {
      res.status(404).json({ error: `Node not found: ${id}` });
      return;
    }
    res.json(node);
  });

  app.get("/api/nodes/:id/diff", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const node = deps.store.getNode(id);
    if (!node) {
      res.status(404).json({ error: `Node not found: ${id}` });
      return;
    }

    const nodeTree = node.snapshotRef;
    if (nodeTree === null) {
      res.json({ changes: [] });
      return;
    }

    const project = deps.store.getProject(node.projectId);
    if (!project) {
      res.json({ changes: [] });
      return;
    }

    try {
      const parentTree = findParentSnapshotRef(deps.store, node);
      const snapshotter = deps.snapshotterFor(project);
      const changes = await snapshotter.diff(parentTree, nodeTree);
      res.json({ changes });
    } catch (err) {
      logError("[sojourn] diff route failed:", err);
      res.json({ changes: [] });
    }
  });

  app.get("/api/nodes/:id/diff/file", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const filePath = typeof req.query.path === "string" ? req.query.path : "";
    const node = deps.store.getNode(id);
    if (!node) {
      res.status(404).json({ error: `Node not found: ${id}` });
      return;
    }

    const nodeTree = node.snapshotRef;
    if (nodeTree === null) {
      res.json({ patch: "" });
      return;
    }

    const project = deps.store.getProject(node.projectId);
    if (!project) {
      res.json({ patch: "" });
      return;
    }

    try {
      const parentTree = findParentSnapshotRef(deps.store, node);
      const snapshotter = deps.snapshotterFor(project);
      const patch = await snapshotter.diffFile(parentTree, nodeTree, filePath);
      res.json({ patch });
    } catch (err) {
      logError("[sojourn] diff/file route failed:", err);
      res.json({ patch: "" });
    }
  });

  app.post("/api/nodes/:id/flags/run", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const node = deps.store.getNode(id);
    if (!node) {
      res.status(404).json({ error: `Node not found: ${id}` });
      return;
    }

    const tier = req.body && typeof req.body.tier === "string" ? req.body.tier : "T1";

    if (tier === "T2") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        res.status(400).json({ error: "T2 requires ANTHROPIC_API_KEY" });
        return;
      }

      try {
        const ctx = await buildCheckContext(deps, fetchJson, node);
        const llm = criticFor(apiKey);
        const flags = await runCritic(llm, ctx);
        // Budget the critic's output exactly like ingest would (V2 must-fix
        // I2): the advisory per-turn budget applies here too, so a manual
        // T2 run can never flood a node past what capture would keep.
        const { kept, digests } = applyBudgets(flags);
        for (const f of kept) deps.store.addFlag(node.id, f);
        for (const d of digests) deps.store.addFlag(node.id, d);

        // Broadcast the node's FULL current flag list so clients replace,
        // never merge (same contract as the ingest pipeline's broadcasts).
        const fullFlags = deps.store.getFlags(node.id);
        try {
          deps.events.broadcast({ type: "flags_updated", nodeId: node.id, flags: fullFlags });
        } catch (err) {
          logError("[sojourn] flags/run (T2): failed to broadcast:", err);
        }

        res.json({ flags: fullFlags });
      } catch (err) {
        logError("[sojourn] flags/run (T2) failed:", err);
        res.status(502).json({ error: "T2 critic call failed" });
      }
      return;
    }

    if (tier !== "T1") {
      res.status(400).json({ error: `Unknown flag tier: ${tier}` });
      return;
    }

    try {
      const ctx = await buildCheckContext(deps, fetchJson, node);
      const flags = await deps.flagEngine.runOnNode(ctx);
      // Same budget pass ingest applies (V2 must-fix I2). Without it, a
      // manual re-run on a storm node re-persists every claim the ingest
      // digest suppressed (distinct evidence -> fresh rows), while the
      // digest still says "+N similar suppressed" — double-counted health,
      // and the storm the budgets exist to contain lands anyway. Budgeting
      // here keeps the kept set identical (store-level (node_id, kind,
      // evidence) dedup) and reconciles the digest row in place.
      const { kept, digests } = applyBudgets(flags);
      for (const f of kept) deps.store.addFlag(node.id, f);
      for (const d of digests) deps.store.addFlag(node.id, d);

      // Broadcast (and return) the node's FULL current flag list so clients
      // replace, never merge.
      const fullFlags = deps.store.getFlags(node.id);
      try {
        deps.events.broadcast({ type: "flags_updated", nodeId: node.id, flags: fullFlags });
      } catch (err) {
        logError("[sojourn] flags/run: failed to broadcast:", err);
      }

      res.json({ flags: fullFlags });
    } catch (err) {
      logError("[sojourn] flags/run failed:", err);
      res.status(500).json({ error: "Failed to run flags" });
    }
  });

  // Deliberately NOT serialized with the ingest chain: preflight is
  // read-only, and restore's safety snapshot uses the snapshotter's private
  // temp-index path (snapshotSafety, own ref) — so an explicit user action
  // never queues behind minutes of capture work, and still can't race the
  // shared ingest index or refs/sojourn/head.
  app.post("/api/nodes/:id/preflight", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    try {
      const preflight = await deps.restoreEngine.preflight(id);
      if (!preflight.treeValid) {
        // Say WHY restore is unavailable, in retention-aware terms: after
        // `soj gc`, a pruned tree fails hasTree() exactly like a
        // never-snapshotted node would.
        preflight.warnings = [
          `Restore unavailable: ${THINNED_SNAPSHOT_PHRASE}.`,
          ...preflight.warnings,
        ];
      }
      res.json(preflight);
    } catch (err) {
      handleRestoreError(err, id, res);
    }
  });

  app.post("/api/nodes/:id/restore", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    try {
      const result = await deps.restoreEngine.restore(id);
      // Exact-conversation companion (V2 Task 5): when the session's
      // transcript is available, the response gains a `rewind` field — the
      // plan is executed (synthesized transcript written) when exact, or
      // returned as the honest tip-mode fallback otherwise. Never fails the
      // restore itself.
      const rewind = await maybeRewindForRestore(deps, id);
      res.json(rewind !== null ? { ...result, rewind } : result);
    } catch (err) {
      handleRestoreError(err, id, res);
    }
  });

  // Pure planning: no side effects, safe to call repeatedly. Claude nodes
  // only — rewind synthesizes Claude transcript files.
  app.post("/api/nodes/:id/rewind-plan", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const node = deps.store.getNode(id);
    if (!node) {
      res.status(404).json({ error: `Node not found: ${id}` });
      return;
    }
    if (node.cli !== "claude") {
      res
        .status(400)
        .json({ error: `Rewind supports claude nodes only (node ${id} is cli "${node.cli}")` });
      return;
    }
    const planned = await planNodeRewind(deps, node);
    if (!planned.ok) {
      res.status(planned.status).json({ error: planned.error });
      return;
    }
    res.json(publicRewindPlan(planned.plan));
  });

  // Executes a rewind. The plan is ALWAYS recomputed server-side from the
  // same transcript read that feeds the execute step — a client-supplied
  // plan body is never trusted (and is ignored entirely).
  app.post("/api/nodes/:id/rewind", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const node = deps.store.getNode(id);
    if (!node) {
      res.status(404).json({ error: `Node not found: ${id}` });
      return;
    }
    if (node.cli !== "claude") {
      res
        .status(400)
        .json({ error: `Rewind supports claude nodes only (node ${id} is cli "${node.cli}")` });
      return;
    }
    const planned = await planNodeRewind(deps, node);
    if (!planned.ok) {
      res.status(planned.status).json({ error: planned.error });
      return;
    }
    try {
      const executed = await executeRewind(planned.plan, planned.rawLines);
      res.json(publicRewindPlan(executed));
    } catch (err) {
      if (err instanceof SojournRewindError) {
        const status = err.code === "transcript_exists" ? 409 : 500;
        if (status >= 500) {
          logError(`[sojourn] rewind failed for node ${id}:`, err);
        }
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      logError(`[sojourn] rewind failed for node ${id}:`, err);
      res.status(500).json({ error: "Rewind failed" });
    }
  });

  app.get("/api/sessions/:id/health", (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    if (deps.store.getSessionNodes(id).length === 0) {
      res.status(404).json({ error: `Session not found: ${id}` });
      return;
    }
    res.json(getSessionHealth(deps.store, id));
  });

  // Last turn's ACTIVE verified flags as compact one-line strings — max 3
  // plus a "+n more" marker. Verified only, ALWAYS: advisory flags never
  // reach this surface (the hook prints these lines straight into the
  // user's terminal, where hedging would be invisible).
  app.get("/api/sessions/:id/turn-flags", (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const nodes = deps.store.getSessionNodes(id);
    if (nodes.length === 0) {
      res.status(404).json({ error: `Session not found: ${id}` });
      return;
    }

    const sinceNodeId =
      typeof req.query.sinceNodeId === "string" && req.query.sinceNodeId.length > 0
        ? req.query.sinceNodeId
        : null;

    let startIdx = 0;
    if (sinceNodeId !== null) {
      const idx = nodes.findIndex((n) => n.id === sinceNodeId);
      if (idx === -1) {
        res.status(404).json({ error: `Node not found in session ${id}: ${sinceNodeId}` });
        return;
      }
      startIdx = idx + 1;
    } else {
      // The Stop hook omits sinceNodeId: default to the session's LAST
      // turn — everything from its final prompt node onward.
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].kind === "prompt") {
          startIdx = i;
          break;
        }
      }
    }

    const active: StoredFlag[] = [];
    for (const n of nodes.slice(startIdx)) {
      for (const f of n.flags ?? []) {
        if (f.tier !== "verified") continue;
        if (f.dismissed || f.autoResolved) continue;
        active.push(f);
      }
    }

    const lines = active.slice(0, TURN_FLAG_LINE_MAX).map(formatFlagLine);
    if (active.length > TURN_FLAG_LINE_MAX) {
      lines.push(`+${active.length - TURN_FLAG_LINE_MAX} more`);
    }
    res.json({ lines });
  });

  app.get("/api/search", (req: Request, res: Response) => {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    if (projectId.length === 0) {
      res.status(400).json({ error: "Query param `projectId` is required" });
      return;
    }
    const q = typeof req.query.q === "string" && req.query.q.length > 0 ? req.query.q : undefined;
    const file =
      typeof req.query.file === "string" && req.query.file.length > 0
        ? req.query.file
        : undefined;
    const kindsRaw = typeof req.query.kinds === "string" ? req.query.kinds : "";
    const kinds = kindsRaw
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0) as NodeKind[];

    try {
      const hits = deps.store.search(projectId, {
        q,
        file,
        kinds: kinds.length > 0 ? kinds : undefined,
      });
      res.json({ hits });
    } catch (err) {
      logError("[sojourn] search route failed:", err);
      res.status(500).json({ error: "Search failed" });
    }
  });

  const harvestFns = deps.harvestEngine ?? {
    preflight: coreHarvestPreflight,
    harvest: coreHarvest,
  };

  app.post("/api/worktrees/harvest/preflight", async (req: Request, res: Response) => {
    const worktreePath =
      req.body && typeof req.body.worktreePath === "string" ? req.body.worktreePath : "";
    if (worktreePath.length === 0) {
      res.status(400).json({ error: "Body must include a string `worktreePath` field" });
      return;
    }
    const ctx = resolveHarvestContext(deps, worktreePath);
    if (!ctx.ok) {
      res.status(ctx.status).json(ctx.body);
      return;
    }
    try {
      res.json(await harvestFns.preflight(ctx.harvestDeps, worktreePath, ctx.mainlineRoot));
    } catch (err) {
      handleHarvestError(err, res);
    }
  });

  app.post("/api/worktrees/harvest", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const worktreePath = typeof body.worktreePath === "string" ? body.worktreePath : "";
    if (worktreePath.length === 0) {
      res.status(400).json({ error: "Body must include a string `worktreePath` field" });
      return;
    }
    const mode = body.mode;
    if (mode !== "apply" && mode !== "patch") {
      res.status(400).json({ error: "Body's `mode` must be one of apply|patch" });
      return;
    }
    const allowConflicts = body.allowConflicts === true;

    const ctx = resolveHarvestContext(deps, worktreePath);
    if (!ctx.ok) {
      res.status(ctx.status).json(ctx.body);
      return;
    }
    try {
      const outcome = await harvestFns.harvest(ctx.harvestDeps, worktreePath, ctx.mainlineRoot, {
        mode,
        allowConflicts,
      });

      // Graph closure: harvest() inserted the merge node directly through
      // the store, so broadcast it (and the project update) the same way
      // the ingest pipeline would.
      if (outcome.mergeNodeId !== null) {
        const mergeNode = deps.store.getNode(outcome.mergeNodeId);
        if (mergeNode) {
          try {
            deps.events.broadcast({ type: "node_added", node: mergeNode });
            deps.events.broadcast({ type: "project_updated", projectId: mergeNode.projectId });
          } catch (err) {
            logError("[sojourn] harvest: failed to broadcast merge node:", err);
          }
        }
      }

      res.json(outcome);
    } catch (err) {
      handleHarvestError(err, res);
    }
  });

  app.post("/api/nodes/:id/annotations", (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const node = deps.store.getNode(id);
    if (!node) {
      res.status(404).json({ error: `Node not found: ${id}` });
      return;
    }
    const text = req.body && typeof req.body.text === "string" ? req.body.text : null;
    if (text === null) {
      res.status(400).json({ error: "Body must include a string `text` field" });
      return;
    }
    const annotation = deps.store.addAnnotation(id, text);
    res.json(annotation);
  });

  app.post("/api/flags/:id/dismiss", (req: Request, res: Response) => {
    const rawId = req.params.id;
    const flagId = Number(decodeId(rawId));
    if (!Number.isInteger(flagId)) {
      res.status(400).json({ error: `Invalid flag id: ${rawId}` });
      return;
    }
    deps.store.dismissFlag(flagId);
    res.json({ ok: true });
  });

  app.post("/api/mark", (req: Request, res: Response) => {
    const body = req.body ?? {};
    const { sessionId, label, kind } = body as {
      sessionId?: unknown;
      label?: unknown;
      kind?: unknown;
    };

    if (typeof sessionId !== "string" || sessionId.length === 0) {
      res.status(400).json({ error: "Body must include a string `sessionId` field" });
      return;
    }
    if (typeof label !== "string" || label.length === 0) {
      res.status(400).json({ error: "Body must include a string `label` field" });
      return;
    }
    if (kind !== "decision" && kind !== "assumption" && kind !== "checkpoint") {
      res
        .status(400)
        .json({ error: "Body's `kind` must be one of decision|assumption|checkpoint" });
      return;
    }

    const parent = deps.store.latestNode(sessionId);
    if (!parent) {
      res.status(404).json({ error: `No nodes found for session: ${sessionId}` });
      return;
    }

    const now = new Date().toISOString();
    const nativeUuid = `mark-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const node: ChronoNode = {
      id: `${parent.cli}:${nativeUuid}`,
      parentId: parent.id,
      kind,
      cli: parent.cli,
      sessionId,
      projectId: parent.projectId,
      timestamp: now,
      snapshotRef: null,
      label,
      summary: label,
      content: { label, kind },
      meta: { nativeUuid },
    };

    deps.store.upsertNode(node);
    const stored = deps.store.getNode(node.id)!;

    try {
      deps.events.broadcast({ type: "node_added", node: stored });
    } catch (err) {
      logError("[sojourn] mark: failed to broadcast node_added:", err);
    }

    res.json(stored);
  });

  app.post("/api/hooks/claude", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const transcriptPath =
      typeof body.transcript_path === "string" ? body.transcript_path : undefined;

    res.json({ ok: true });

    if (transcriptPath && deps.rescanClaudeTranscript) {
      try {
        await deps.rescanClaudeTranscript(transcriptPath);
      } catch (err) {
        logError("[sojourn] hooks/claude: rescan failed:", err);
      }
    }
  });

  app.post("/api/hooks/opencode", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;

    // Respond immediately — the rescan is fire-and-forget and must never
    // block or fail the hook caller (capture never blocks the session).
    res.json({ ok: true });

    if (sessionId && deps.rescanOpenCodeSession) {
      try {
        await deps.rescanOpenCodeSession(sessionId);
      } catch (err) {
        logError("[sojourn] hooks/opencode: rescan failed:", err);
      }
    }
  });

  const webDist = resolveWebDist();
  if (webDist) {
    app.use(express.static(webDist));
  }

  // JSON 404 for any unmatched /api/* route — must come before the SPA
  // fallback below so unknown API routes never fall through to index.html
  // (and never hit Express's default HTML 404 page).
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: `Not found: ${_req.originalUrl}` });
  });

  if (webDist) {
    app.get("*", (req: Request, res: Response, next) => {
      if (req.path.startsWith("/api/") || req.path === "/ws") {
        next();
        return;
      }
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  // Final error-handling middleware (4-arg signature is what makes Express
  // treat this as an error handler rather than a normal middleware).
  // Catches body-parser SyntaxError (malformed JSON) as well as any
  // uncaught throw from a route handler — capture must never leak an HTML
  // error page; every API error is JSON `{ error: string }`.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err && typeof err === "object" && "status" in err && typeof err.status === "number"
        ? err.status
        : err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "number"
          ? err.statusCode
          : 500;
    const message = err instanceof Error ? err.message : "Internal error";
    if (status >= 500) {
      logError("[sojourn] unhandled error in request pipeline:", err);
    }
    res.status(status).json({ error: message });
  });

  return app;
}

/**
 * Per-node `restorable` for the graph route, computed SCALE-SAFELY over the
 * IN-MEMORY `nodes` array — never a per-node store round-trip and never a
 * per-node git call (the O(n^2) ingest-OOM lesson, commit d22b490; this is
 * that same hot route). Two passes:
 *
 *   1. Effective-tree resolution, pure and in-memory. Mirrors
 *      findEffectiveTree()'s canonical self-first, cycle-guarded
 *      nearest-ancestor-snapshot walk (so this matches restore/gc/preflight
 *      by construction), but reads parents from a Map built ONCE from
 *      `nodes` instead of store.getNode(), and MEMOIZES the resolved tree for
 *      every node visited on a walk (path-compression, like d22b490's
 *      turn-base memo) so the whole array resolves in O(n) total. A node with
 *      no own snapshotRef and no snapshotted ancestor -> effective tree null.
 *      This pass cannot throw.
 *   2. hasTree() called ONCE per DISTINCT non-null effective tree (a small
 *      capped concurrent pool), cached for the request. A node is restorable
 *      iff its effective tree is non-null AND that tree validates — exactly
 *      the preflight `treeValid` semantics (RestoreEngine.preflight:
 *      `treeHash !== null && await hasTree(treeHash)`).
 *
 * Fail-open, two ways, because preflight is the hard gate before any actual
 * checkout and a flaky probe must never grey out a genuinely-restorable
 * node's button: (a) hasTree throwing for a tree -> that tree is treated as
 * VALID; (b) a catastrophic failure obtaining the snapshotter at all -> every
 * distinct tree treated valid. A node that simply has no snapshot anywhere
 * stays restorable:false in every case (its effective tree is null).
 */
async function computeRestorable(
  deps: ServerDeps,
  project: Project,
  nodes: ChronoNode[],
): Promise<Map<string, boolean>> {
  // ---- Pass 1: in-memory effective trees (pure; cannot throw) ----
  const byId = new Map<string, ChronoNode>();
  for (const n of nodes) byId.set(n.id, n);

  // nodeId -> effective tree hash (null = no own/ancestor snapshot).
  const effTree = new Map<string, string | null>();

  const resolveEffTree = (startId: string): string | null => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let curId: string | null = startId;
    let result: string | null = null;
    while (curId !== null) {
      if (effTree.has(curId)) {
        result = effTree.get(curId) ?? null; // memo hit (path compression)
        break;
      }
      if (seen.has(curId)) break; // cycle guard -> result stays null
      seen.add(curId);
      const cur = byId.get(curId);
      if (!cur) break; // parent absent from graph -> null (findEffectiveTree parity)
      if (cur.snapshotRef !== null) {
        result = cur.snapshotRef; // self-first: nearest own/ancestor snapshot
        effTree.set(curId, result); // memoize the snapshot-bearing node itself
        break;
      }
      chain.push(curId);
      curId = cur.parentId;
    }
    for (const id of chain) effTree.set(id, result);
    return result;
  };

  const distinctTrees = new Set<string>();
  for (const n of nodes) {
    const t = resolveEffTree(n.id);
    if (t !== null) distinctTrees.add(t);
  }

  // ---- Pass 2: hasTree ONCE per distinct tree (the only git work) ----
  const valid = new Map<string, boolean>();
  const treeList = [...distinctTrees];
  try {
    const snapshotter = deps.snapshotterFor(project);
    const CONCURRENCY = 8;
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < treeList.length) {
        const tree = treeList[idx++];
        try {
          valid.set(tree, await snapshotter.hasTree(tree));
        } catch {
          valid.set(tree, true); // fail-open: transient git error -> keep the button live
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, treeList.length) }, () => worker()),
    );
  } catch (err) {
    // Couldn't even obtain a snapshotter (or the whole batch rejected): fail
    // OPEN for every distinct tree rather than 500 the page every reader
    // loads. Nodes with a null effective tree still resolve to false below.
    logError("[sojourn] graph route: restorable hasTree pass failed (failing open):", err);
    for (const tree of treeList) if (!valid.has(tree)) valid.set(tree, true);
  }

  const restorable = new Map<string, boolean>();
  for (const n of nodes) {
    const t = effTree.get(n.id) ?? null;
    restorable.set(n.id, t !== null && valid.get(t) === true);
  }
  return restorable;
}

function findParentSnapshotRef(
  store: GraphStore,
  node: { parentId: string | null; snapshotRef: string | null },
): string | null {
  let currentParentId = node.parentId;
  const seen = new Set<string>();
  while (currentParentId !== null) {
    if (seen.has(currentParentId)) break;
    seen.add(currentParentId);
    const parent = store.getNode(currentParentId);
    if (!parent) break;
    if (parent.snapshotRef !== null) return parent.snapshotRef;
    currentParentId = parent.parentId;
  }
  return null;
}

function handleRestoreError(err: unknown, nodeId: string, res: Response): void {
  if (err instanceof SojournRestoreError) {
    const message = err.message;
    switch (err.code) {
      case "not_found":
        res.status(404).json({ error: message });
        return;
      case "invalid_tree":
        // Retention-aware phrasing: after `soj gc`, a pruned tree fails
        // hasTree() exactly like a never-snapshotted node would.
        res.status(400).json({ error: `${message} (${THINNED_SNAPSHOT_PHRASE})` });
        return;
      case "dest_exhausted":
        logError(`[sojourn] restore-related route failed for node ${nodeId}:`, err);
        res.status(500).json({ error: message });
        return;
      default:
        // Fallback for safety in case a future SojournRestoreError is
        // constructed without going through the typed `code` sites above
        // (or an older/mismatched core build is linked).
        if (message.includes("not found")) {
          res.status(404).json({ error: message });
          return;
        }
        res.status(400).json({ error: message });
        return;
    }
  }
  logError(`[sojourn] restore-related route failed for node ${nodeId}:`, err);
  res.status(500).json({ error: "Internal error" });
}
