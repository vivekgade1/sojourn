import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GraphStore, FlagEngine } from "@sojourn/core";
import type { ChronoNode, FetchJson, IngestBatch, Project, SnapshotterLike } from "@sojourn/core";
import { runSerialized } from "../src/serialize.js";
import { ingestBatch, type IngestDeps } from "../src/ingest.js";

/** Waits one microtask tick — enough for a competing async call to have
 * started (and, if the serializer were broken, to have entered the
 * critical section concurrently) before we check invariants. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("runSerialized", () => {
  it("never runs two calls for the SAME key concurrently", async () => {
    let active = false;
    const order: string[] = [];

    const task = async (label: string): Promise<void> => {
      if (active) {
        throw new Error(`re-entrant: ${label} started while another call for the key was active`);
      }
      active = true;
      order.push(`start:${label}`);
      await tick();
      await tick();
      order.push(`end:${label}`);
      active = false;
    };

    const p1 = runSerialized("project-a", () => task("first"));
    const p2 = runSerialized("project-a", () => task("second"));

    await expect(Promise.all([p1, p2])).resolves.toEqual([undefined, undefined]);

    // both ran, and the second did not start until the first finished.
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("allows calls for DIFFERENT keys to interleave (no cross-key waiting)", async () => {
    const order: string[] = [];

    const taskA = async (): Promise<void> => {
      order.push("A:start");
      await tick();
      await tick();
      order.push("A:end");
    };
    const taskB = async (): Promise<void> => {
      order.push("B:start");
      await tick();
      order.push("B:end");
    };

    const pA = runSerialized("project-a", taskA);
    const pB = runSerialized("project-b", taskB);

    await Promise.all([pA, pB]);

    // B (fewer ticks) finishes before A even though A started first —
    // proof the two keys ran concurrently rather than B waiting on A.
    expect(order.indexOf("B:end")).toBeLessThan(order.indexOf("A:end"));
    expect(order[0]).toBe("A:start");
    expect(order[1]).toBe("B:start");
  });

  it("does not grow the internal queue unboundedly — settled+current entries are cleared", async () => {
    for (let i = 0; i < 50; i++) {
      await runSerialized("project-a", async () => {
        await tick();
      });
    }
    expect(__pendingKeyCount()).toBe(0);
  });

  it("propagates a rejection to its own caller without breaking later calls for the same key", async () => {
    await expect(
      runSerialized("project-a", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // a subsequent call for the same key still runs fine afterward.
    const result = await runSerialized("project-a", async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("runSerialized applied to ingestBatch (real re-entrancy scenario)", () => {
  function makeNode(id: string, sessionId: string): ChronoNode {
    return {
      id: `claude:${id}`,
      parentId: null,
      kind: "assistant",
      cli: "claude",
      sessionId,
      projectId: "",
      timestamp: "2026-01-01T00:00:00.000Z",
      snapshotRef: null,
      label: null,
      summary: "",
      content: { type: "text", text: "hi" },
      meta: { nativeUuid: id },
    };
  }

  /** A snapshotter double whose snapshot() sets an "active" flag, awaits a
   * couple of ticks (to give a would-be concurrent caller a chance to
   * enter), and throws if it was ALREADY active on entry — this is the
   * shared-mutable-state stand-in for the real ShadowSnapshotter's shared
   * GIT_INDEX_FILE / non-atomic ref update. */
  function makeGuardedSnapshotter(): SnapshotterLike & { snapshotCount: number } {
    let active = false;
    return {
      snapshotCount: 0,
      async init() {},
      async snapshot() {
        if (active) {
          throw new Error("re-entrant: snapshot() entered while already active");
        }
        active = true;
        this.snapshotCount++;
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        active = false;
        return `tree-${this.snapshotCount}`;
      },
      async hasTree() {
        return true;
      },
      async diff() {
        return [];
      },
      async diffFile() {
        return "";
      },
      async listFiles() {
        return [];
      },
      async readFile() {
        return null;
      },
      async restoreToWorktree() {},
    };
  }

  function makeIngestDeps(snapshotterFor: (project: Project) => SnapshotterLike): {
    deps: IngestDeps;
    store: GraphStore;
  } {
    const store = new GraphStore(":memory:");
    const flagEngine = new FlagEngine();
    const fetchJson = vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson;
    return {
      store,
      deps: {
        store,
        flagEngine,
        events: { broadcast() {} },
        fetchJson,
        snapshotterFor,
      },
    };
  }

  it("two concurrent ingestBatch calls for the SAME project, routed through the serializer, never overlap in the snapshotter and both complete", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-serialize-project-"));
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");
    try {
      const snapshotter = makeGuardedSnapshotter();
      const { deps, store } = makeIngestDeps(() => snapshotter);
      const key = path.resolve(projectRoot);

      const batch1: IngestBatch = {
        project: { root: projectRoot, name: "test" },
        session: { id: "s1", cli: "claude" },
        nodes: [makeNode("n1", "s1")],
      };
      const batch2: IngestBatch = {
        project: { root: projectRoot, name: "test" },
        session: { id: "s1", cli: "claude" },
        nodes: [makeNode("n1", "s1"), makeNode("n2", "s1")],
      };

      const [r1, r2] = await Promise.all([
        runSerialized(key, () => ingestBatch(deps, batch1)),
        runSerialized(key, () => ingestBatch(deps, batch2)),
      ]);

      expect(r1).toBeDefined();
      expect(r2).toBeDefined();
      expect(snapshotter.snapshotCount).toBe(2);

      store.close();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("ingestBatch calls for DIFFERENT projects, both routed through the serializer, may interleave rather than waiting on each other", async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-serialize-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-serialize-b-"));
    await fsp.writeFile(path.join(rootA, "a.txt"), "hello");
    await fsp.writeFile(path.join(rootB, "b.txt"), "hello");
    try {
      const snapshotterA = makeGuardedSnapshotter();
      const snapshotterB = makeGuardedSnapshotter();
      const { deps: depsA } = makeIngestDeps(() => snapshotterA);
      const { deps: depsB } = makeIngestDeps(() => snapshotterB);

      const order: string[] = [];
      const originalSnapshotA = snapshotterA.snapshot.bind(snapshotterA);
      snapshotterA.snapshot = async () => {
        order.push("A:start");
        const result = await originalSnapshotA();
        order.push("A:end");
        return result;
      };
      const originalSnapshotB = snapshotterB.snapshot.bind(snapshotterB);
      snapshotterB.snapshot = async () => {
        order.push("B:start");
        const result = await originalSnapshotB();
        order.push("B:end");
        return result;
      };

      const batchA: IngestBatch = {
        project: { root: rootA, name: "a" },
        session: { id: "sa", cli: "claude" },
        nodes: [makeNode("na", "sa")],
      };
      const batchB: IngestBatch = {
        project: { root: rootB, name: "b" },
        session: { id: "sb", cli: "claude" },
        nodes: [makeNode("nb", "sb")],
      };

      await Promise.all([
        runSerialized(path.resolve(rootA), () => ingestBatch(depsA, batchA)),
        runSerialized(path.resolve(rootB), () => ingestBatch(depsB, batchB)),
      ]);

      // Both started before either finished — proof the two project keys
      // ran concurrently instead of B waiting for A's chain.
      expect(order.indexOf("A:start")).toBeLessThan(order.indexOf("A:end"));
      expect(order.indexOf("B:start")).toBeLessThan(order.indexOf("B:end"));
      expect(order.indexOf("B:start")).toBeLessThan(order.indexOf("A:end"));
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});

// Re-exported test-only helper — see src/serialize.ts.
import { __pendingKeyCount } from "../src/serialize.js";
