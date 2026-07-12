import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { claudeProjectsDir, parseSessionJsonl } from "@sojourn/adapter-claude";
import type { IngestDeps } from "./ingest.js";
import { ingestBatch } from "./ingest.js";
import { runSerialized } from "./serialize.js";

const DEBOUNCE_MS = 300;

export interface WatcherHandle {
  close(): Promise<void>;
  /** Immediately (re)scan one transcript file, bypassing the debounce —
   * used by POST /api/hooks/claude for an instant re-scan. */
  rescan(filePath: string): Promise<void>;
}

/**
 * Watches the Claude transcript directory recursively (chokidar 4 dropped
 * glob support, so we watch the whole directory and filter events to
 * `*.jsonl` ourselves). On add/change, the WHOLE file is re-parsed after a
 * per-file debounce — cheap, and safe because ingestBatch's upserts are
 * idempotent.
 */
export function startWatcher(deps: IngestDeps, dir: string = claudeProjectsDir()): WatcherHandle {
  const timers = new Map<string, NodeJS.Timeout>();

  const watcher: FSWatcher = chokidar.watch(dir, {
    ignoreInitial: false,
    persistent: true,
  });

  const scan = async (filePath: string): Promise<void> => {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const batch = parseSessionJsonl(filePath, raw);
      if (batch === null) return;
      // Record where this session's transcript lives (and the cwd it ran
      // in) so the rewind routes can load raw lines and the flag routes can
      // resolve a worktree-aliased session's actual disk root.
      deps.transcripts?.record(batch.session.id, {
        transcriptPath: filePath,
        diskRoot: batch.project.root,
      });
      // Route every ingestBatch call through the per-project serializer:
      // the debounce above only dedupes the TIMER per file, not an
      // in-flight scan, so without this a debounced watcher scan could
      // overlap a hook-triggered rescan (wire.ts) for the same project and
      // race on that project's single ShadowSnapshotter.
      const key = path.resolve(batch.project.root);
      await runSerialized(key, () => ingestBatch(deps, batch));
    } catch (err) {
      console.error(`[sojourn] watcher: failed to scan ${filePath}:`, err);
    }
  };

  const scheduleScan = (filePath: string): void => {
    if (path.extname(filePath) !== ".jsonl") return;
    const existing = timers.get(filePath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(filePath);
      void scan(filePath);
    }, DEBOUNCE_MS);
    timers.set(filePath, timer);
  };

  watcher.on("add", scheduleScan);
  watcher.on("change", scheduleScan);
  watcher.on("error", (err) => {
    console.error("[sojourn] watcher error:", err);
  });

  return {
    async close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await watcher.close();
    },
    async rescan(filePath: string) {
      const existing = timers.get(filePath);
      if (existing) {
        clearTimeout(existing);
        timers.delete(filePath);
      }
      await scan(filePath);
    },
  };
}
