import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { Server as HttpServer } from "node:http";
import type { Express } from "express";
import {
  FlagEngine,
  GraphStore,
  RestoreEngine,
  ShadowSnapshotter,
  dbPath,
  snapshotsDir,
  sojournHome,
  worktreesDir,
} from "@sojourn/core";
import type { FetchJson, Project, SnapshotterLike } from "@sojourn/core";
import { claudeProjectsDir, parseSessionJsonl } from "@sojourn/adapter-claude";
import { createApp } from "./server.js";
import { ingestBatch, type IngestDeps } from "./ingest.js";
import { EventsHub } from "./events.js";
import { startWatcher, type WatcherHandle } from "./watcher.js";
import { runSerialized } from "./serialize.js";

/**
 * True when `candidate` resolves to a path that is inside `dir` (or `dir`
 * itself). Both are `path.resolve`d first so `..` segments and relative
 * inputs can't escape the check, and the containment test compares against
 * `dir + path.sep` (never a bare string prefix) so a sibling directory that
 * merely shares a string prefix — e.g. `projects-evil` vs `projects` — is
 * correctly rejected.
 */
export function isPathInsideDir(candidate: string, dir: string): boolean {
  const resolvedDir = path.resolve(dir);
  const resolvedCandidate = path.resolve(candidate);
  const dirWithSep = resolvedDir.endsWith(path.sep) ? resolvedDir : resolvedDir + path.sep;
  return resolvedCandidate === resolvedDir || resolvedCandidate.startsWith(dirWithSep);
}

/** Real fetch-with-3s-timeout used by T1 checks that hit package registries. */
export function realFetchJson(): FetchJson {
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

/** Builds a `snapshotterFor` function that inits a `ShadowSnapshotter`
 * exactly once per project and caches it thereafter. */
function makeSnapshotterFor(): (project: Project) => SnapshotterLike {
  const cache = new Map<string, SnapshotterLike>();
  return (project: Project): SnapshotterLike => {
    const existing = cache.get(project.id);
    if (existing) return existing;
    const snapshotter = new ShadowSnapshotter({
      projectRoot: project.root,
      shadowDir: snapshotsDir(project.id),
    });
    cache.set(project.id, snapshotter);
    return snapshotter;
  };
}

function readOwnVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface BuiltDaemon {
  store: GraphStore;
  /** Builds the express app; must be called before `attachWatcher`. Takes
   * the http server so the WS hub can attach to it. */
  createExpressApp(server: HttpServer): Express;
  /** Starts the chokidar watcher over the Claude transcripts directory,
   * wired to the same ingest pipeline the HTTP hooks use. */
  attachWatcher(server: HttpServer): WatcherHandle;
}

/**
 * Composes the real (non-test) daemon dependency graph, honoring
 * SOJOURN_HOME (via @sojourn/core's paths helpers) for the DB, snapshots,
 * and worktrees locations.
 */
export function buildDaemon(): BuiltDaemon {
  const home = sojournHome();
  fs.mkdirSync(home, { recursive: true });

  const store = new GraphStore(dbPath());
  const snapshotterFor = makeSnapshotterFor();
  const flagEngine = new FlagEngine();
  const restoreEngine = new RestoreEngine({
    store,
    snapshotterFor,
    worktreesDir: worktreesDir(),
  });
  const fetchJson = realFetchJson();
  const version = readOwnVersion();

  let events: EventsHub | undefined;
  let ingestDeps: IngestDeps | undefined;

  function ensureWired(server: HttpServer): IngestDeps {
    if (!ingestDeps) {
      events = new EventsHub(server);
      ingestDeps = { store, snapshotterFor, flagEngine, events, fetchJson };
    }
    return ingestDeps;
  }

  async function rescanClaudeTranscript(transcriptPath: string): Promise<void> {
    if (!ingestDeps) return;

    // transcript_path arrives from the client-controlled POST body of
    // /api/hooks/claude — without this check it's an arbitrary filesystem
    // read oracle (e.g. transcript_path: "/etc/passwd"). Only ever read
    // paths inside the real Claude projects directory; anything else is
    // logged once and silently ignored (the route itself still 200s —
    // capture must never surface this as a user-facing failure).
    const projectsDir = claudeProjectsDir();
    if (!isPathInsideDir(transcriptPath, projectsDir)) {
      console.error(
        `[sojourn] hooks/claude: rejected transcript_path outside ${projectsDir}: ${transcriptPath}`,
      );
      return;
    }

    const raw = await fsp.readFile(transcriptPath, "utf8");
    const batch = parseSessionJsonl(transcriptPath, raw);
    if (batch === null) return;
    const key = path.resolve(batch.project.root);
    await runSerialized(key, () => ingestBatch(ingestDeps!, batch));
  }

  return {
    store,
    createExpressApp(server: HttpServer) {
      const deps = ensureWired(server);
      return createApp({
        store,
        snapshotterFor,
        flagEngine,
        restoreEngine,
        events: deps.events,
        version,
        fetchJson,
        rescanClaudeTranscript,
      });
    },
    attachWatcher(server: HttpServer) {
      const deps = ensureWired(server);
      return startWatcher(deps, claudeProjectsDir());
    },
  };
}
