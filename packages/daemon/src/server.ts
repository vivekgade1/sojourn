import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type {
  ChronoNode,
  CheckContext,
  CriticLLM,
  FlagEngine,
  GraphStore,
  Project,
  RestoreEngine,
  SnapshotterLike,
} from "@sojourn/core";
import { runCritic, SojournRestoreError } from "@sojourn/core";
import { resolveTurnBaseTree, type EventsSink } from "./ingest.js";
import type { FetchJson } from "@sojourn/core";
import { anthropicCritic } from "./critic.js";
import { runSerialized } from "./serialize.js";

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

  let diff: Awaited<ReturnType<SnapshotterLike["diff"]>> = [];
  let snapshotter: SnapshotterLike | null = null;
  if (project && nodeTree !== null) {
    try {
      snapshotter = deps.snapshotterFor(project);
      diff = await snapshotter.diff(parentTree, nodeTree);
    } catch (err) {
      console.error("[sojourn] flags/run: diff failed:", err);
    }
  }

  return {
    node,
    priorNodes: sessionNodes,
    diff,
    parentTree,
    nodeTree,
    projectRoot: project?.root ?? "",
    snapshotter,
    fetchJson,
  };
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

  app.get("/api/projects/:id/graph", (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    const project = deps.store.getProject(id);
    if (!project) {
      res.status(404).json({ error: `Project not found: ${id}` });
      return;
    }
    const sessions = deps.store.getSessions(id);
    const nodes = deps.store.getGraph(id);
    res.json({ project, sessions, nodes });
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
      console.error("[sojourn] diff route failed:", err);
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
      console.error("[sojourn] diff/file route failed:", err);
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
        for (const f of flags) deps.store.addFlag(node.id, f);

        // Broadcast the node's FULL current flag list so clients replace,
        // never merge (same contract as the ingest pipeline's broadcasts).
        const fullFlags = deps.store.getFlags(node.id);
        try {
          deps.events.broadcast({ type: "flags_updated", nodeId: node.id, flags: fullFlags });
        } catch (err) {
          console.error("[sojourn] flags/run (T2): failed to broadcast:", err);
        }

        res.json({ flags: fullFlags });
      } catch (err) {
        console.error("[sojourn] flags/run (T2) failed:", err);
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
      for (const f of flags) deps.store.addFlag(node.id, f);

      // Broadcast (and return) the node's FULL current flag list so clients
      // replace, never merge.
      const fullFlags = deps.store.getFlags(node.id);
      try {
        deps.events.broadcast({ type: "flags_updated", nodeId: node.id, flags: fullFlags });
      } catch (err) {
        console.error("[sojourn] flags/run: failed to broadcast:", err);
      }

      res.json({ flags: fullFlags });
    } catch (err) {
      console.error("[sojourn] flags/run failed:", err);
      res.status(500).json({ error: "Failed to run flags" });
    }
  });

  /**
   * Serializer key for restore-related work on a node: the node's project
   * root (resolved), i.e. the SAME key ingestion uses. Restore/preflight
   * touch the project's single ShadowSnapshotter (safety snapshot, tree
   * checks), so they must never overlap an in-flight ingest snapshot for
   * that project. Null when the node/project is unknown — the engine will
   * throw its own typed not_found in that case, no serialization needed.
   */
  function restoreSerializerKey(nodeId: string): string | null {
    const node = deps.store.getNode(nodeId);
    if (!node) return null;
    const project = deps.store.getProject(node.projectId);
    if (!project) return null;
    return path.resolve(project.root);
  }

  app.post("/api/nodes/:id/preflight", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    try {
      const key = restoreSerializerKey(id);
      const preflight = key
        ? await runSerialized(key, () => deps.restoreEngine.preflight(id))
        : await deps.restoreEngine.preflight(id);
      res.json(preflight);
    } catch (err) {
      handleRestoreError(err, id, res);
    }
  });

  app.post("/api/nodes/:id/restore", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    try {
      const key = restoreSerializerKey(id);
      const result = key
        ? await runSerialized(key, () => deps.restoreEngine.restore(id))
        : await deps.restoreEngine.restore(id);
      res.json(result);
    } catch (err) {
      handleRestoreError(err, id, res);
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
      console.error("[sojourn] mark: failed to broadcast node_added:", err);
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
        console.error("[sojourn] hooks/claude: rescan failed:", err);
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
        console.error("[sojourn] hooks/opencode: rescan failed:", err);
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
      console.error("[sojourn] unhandled error in request pipeline:", err);
    }
    res.status(status).json({ error: message });
  });

  return app;
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
        res.status(400).json({ error: message });
        return;
      case "dest_exhausted":
        console.error(`[sojourn] restore-related route failed for node ${nodeId}:`, err);
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
  console.error(`[sojourn] restore-related route failed for node ${nodeId}:`, err);
  res.status(500).json({ error: "Internal error" });
}
