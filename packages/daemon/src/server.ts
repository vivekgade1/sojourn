import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import express, { type Express, type Request, type Response } from "express";
import type {
  ChronoNode,
  FlagEngine,
  GraphStore,
  Project,
  RestoreEngine,
  SnapshotterLike,
} from "@sojourn/core";
import { SojournRestoreError } from "@sojourn/core";
import type { EventsSink } from "./ingest.js";
import type { FetchJson } from "@sojourn/core";

export interface ServerDeps {
  store: GraphStore;
  snapshotterFor(project: Project): SnapshotterLike;
  flagEngine: FlagEngine;
  restoreEngine: RestoreEngine;
  events: EventsSink;
  version: string;
  fetchJson?: FetchJson;
  /**
   * Re-scans a Claude transcript file immediately (used by
   * POST /api/hooks/claude). Injected so tests can assert it was called
   * without touching the real filesystem watcher.
   */
  rescanClaudeTranscript?: (transcriptPath: string) => Promise<void> | void;
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

export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json());

  const fetchJson = deps.fetchJson ?? defaultFetchJson();

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
      if (!process.env.ANTHROPIC_API_KEY) {
        res.status(400).json({ error: "ANTHROPIC_API_KEY is required to run T2 checks" });
        return;
      }
      res.status(501).json({ error: "T2 critic is not wired yet" });
      return;
    }

    if (tier !== "T1") {
      res.status(400).json({ error: `Unknown flag tier: ${tier}` });
      return;
    }

    try {
      const project = deps.store.getProject(node.projectId);
      const sessionNodes = deps.store.getSessionNodes(node.sessionId);
      const parentTree = findParentSnapshotRef(deps.store, node);
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

      const ctx = {
        node,
        priorNodes: sessionNodes,
        diff,
        parentTree,
        nodeTree,
        projectRoot: project?.root ?? "",
        snapshotter,
        fetchJson,
      };

      const flags = await deps.flagEngine.runOnNode(ctx);
      const stored = flags.map((f) => deps.store.addFlag(node.id, f));

      try {
        deps.events.broadcast({ type: "flags_updated", nodeId: node.id, flags: stored });
      } catch (err) {
        console.error("[sojourn] flags/run: failed to broadcast:", err);
      }

      res.json({ flags: stored });
    } catch (err) {
      console.error("[sojourn] flags/run failed:", err);
      res.status(500).json({ error: "Failed to run flags" });
    }
  });

  app.post("/api/nodes/:id/preflight", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    try {
      const preflight = await deps.restoreEngine.preflight(id);
      res.json(preflight);
    } catch (err) {
      handleRestoreError(err, id, res);
    }
  });

  app.post("/api/nodes/:id/restore", async (req: Request, res: Response) => {
    const id = decodeId(req.params.id);
    try {
      const result = await deps.restoreEngine.restore(id);
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

  app.post("/api/hooks/opencode", (req: Request, res: Response) => {
    console.log("[sojourn] received opencode hook:", JSON.stringify(req.body ?? {}));
    res.json({ ok: true });
  });

  const webDist = resolveWebDist();
  if (webDist) {
    app.use(express.static(webDist));
    app.get("*", (req: Request, res: Response, next) => {
      if (req.path.startsWith("/api/") || req.path === "/ws") {
        next();
        return;
      }
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

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
    if (message.includes("not found")) {
      res.status(404).json({ error: message });
      return;
    }
    res.status(400).json({ error: message });
    return;
  }
  console.error(`[sojourn] restore-related route failed for node ${nodeId}:`, err);
  res.status(500).json({ error: "Internal error" });
}
