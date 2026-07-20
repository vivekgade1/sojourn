import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphStore, FlagEngine, ShadowSnapshotter } from "@sojourn/core";
import type { FetchJson, Project, SnapshotterLike } from "@sojourn/core";
import { startWatcher, type WatcherHandle } from "../src/watcher.js";
import { TranscriptIndex } from "../src/transcripts.js";
import type { IngestDeps } from "../src/ingest.js";

/** Polls until `cond()` is true or `ms` elapsed.
 *
 * KNOWN FLAKE (pre-existing, unfixed): under full-suite load this test
 * intermittently fails because chokidar never delivers the add event at all.
 * In isolation the wait resolves in ~400ms; on a saturated machine it can miss
 * entirely. Raising the deadline to 20s was tried and did NOT help, which is
 * what rules out "deadline too tight" — the event is lost, not late. Measured
 * on an untouched v1.2.0 checkout it reproduced in 2 of 3 full runs, so it is
 * a property of the watcher test setup, not of any recent change.
 *
 * If you see this fail, re-run the file in isolation before treating it as a
 * regression. The real fix is to stop depending on chokidar delivery here —
 * drive the ingest path directly, or inject a watcher event — rather than to
 * widen the timeout again. */
async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

describe("startWatcher — rewind sidecar tolerance (V2 must-fix I3)", () => {
  let watchDir: string;
  let projectRoot: string;
  let shadowRoot: string;
  let store: GraphStore;
  let transcripts: TranscriptIndex;
  let handle: WatcherHandle | null = null;

  beforeEach(() => {
    watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-watcher-dir-"));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-watcher-project-"));
    shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-watcher-shadow-"));
    store = new GraphStore(":memory:");
    transcripts = new TranscriptIndex();
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    store.close();
    for (const d of [watchDir, projectRoot, shadowRoot]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function makeDeps(): IngestDeps {
    return {
      store,
      flagEngine: new FlagEngine(),
      events: { broadcast() {} },
      fetchJson: vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson,
      transcripts,
      snapshotterFor(project: Project): SnapshotterLike {
        return new ShadowSnapshotter({
          projectRoot: project.root,
          shadowDir: path.join(shadowRoot, project.id),
        });
      },
    };
  }

  it("ignores .sojourn-rewind.json sidecar files (non-.jsonl) while still ingesting real transcripts", async () => {
    const errorSpy = vi.spyOn(console, "error");
    handle = startWatcher(makeDeps(), watchDir);

    // A sidecar landing in the watched dir (exactly what executeRewind
    // writes next to its synthesized transcript) must be a non-event.
    await fsp.writeFile(
      path.join(watchDir, "some-session.sojourn-rewind.json"),
      JSON.stringify({ originSessionId: "s", originNodeId: "claude:x", lineUuids: ["u"] }),
      "utf8",
    );

    // A real transcript next to it ingests normally.
    const line = JSON.stringify({
      type: "user",
      uuid: "watch-u1",
      parentUuid: null,
      sessionId: "watch-session",
      cwd: projectRoot,
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "hello" },
    });
    await fsp.writeFile(path.join(watchDir, "watch-session.jsonl"), line + "\n", "utf8");

    const ingested = await waitFor(() => store.getNode("claude:watch-u1") !== null);
    expect(ingested).toBe(true);

    // The sidecar itself never entered the pipeline: no scan failure was
    // logged for it, and nothing sidecar-shaped reached the store.
    const sidecarErrors = errorSpy.mock.calls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("sojourn-rewind.json")),
    );
    expect(sidecarErrors).toEqual([]);
    errorSpy.mockRestore();
  });
});

describe("startWatcher — scan-failure log dedup (no log storms)", () => {
  let watchDir: string;
  let shadowRoot: string;
  let store: GraphStore;
  let handle: WatcherHandle | null = null;

  beforeEach(() => {
    watchDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-watcher-dedup-"));
    shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-watcher-dedup-shadow-"));
    store = new GraphStore(":memory:");
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    store.close();
    for (const d of [watchDir, shadowRoot]) fs.rmSync(d, { recursive: true, force: true });
  });

  function makeDeps(): IngestDeps {
    return {
      store,
      flagEngine: new FlagEngine(),
      events: { broadcast() {} },
      fetchJson: vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson,
      transcripts: new TranscriptIndex(),
      snapshotterFor(project: Project): SnapshotterLike {
        return new ShadowSnapshotter({
          projectRoot: project.root,
          shadowDir: path.join(shadowRoot, project.id),
        });
      },
    };
  }

  it("a transcript that fails to scan logs once per file version, again after the version changes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    handle = startWatcher(makeDeps(), watchDir);

    // A DIRECTORY named *.jsonl: readFile fails with EISDIR every time.
    const brokenPath = path.join(watchDir, "broken.jsonl");
    fs.mkdirSync(brokenPath);

    const scanFailures = () =>
      errorSpy.mock.calls.filter((args) =>
        args.some((a) => typeof a === "string" && a.includes("failed to scan")),
      ).length;

    await handle.rescan(brokenPath);
    expect(scanFailures()).toBe(1);

    // Same file version -> repeated scans stay silent.
    await handle.rescan(brokenPath);
    await handle.rescan(brokenPath);
    expect(scanFailures()).toBe(1);

    // Version bump (dir mtime/size changes when an entry lands) -> logs once more.
    await new Promise((r) => setTimeout(r, 20)); // ensure a distinct mtime tick
    fs.writeFileSync(path.join(brokenPath, "entry"), "x", "utf8");
    await handle.rescan(brokenPath);
    expect(scanFailures()).toBe(2);

    errorSpy.mockRestore();
  });
});
