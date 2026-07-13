import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { GraphStore, ShadowSnapshotter, FlagEngine, RestoreEngine } from "@sojourn/core";
import type { ChronoNode, FetchJson, Project, SnapshotterLike } from "@sojourn/core";
import { createApp, type ServerDeps } from "../src/server.js";
import type { SojournEvent } from "../src/events.js";

/**
 * `restorable` on the graph route — the daemon's answer to "should this
 * node's restore button be live". Its semantics MUST equal the preflight
 * `treeValid` for the same node (effective tree exists AND its shadow-git
 * tree is reachable), and it MUST be computed WITHOUT a per-node git call —
 * the graph route is hit on every page load and every websocket reconnect,
 * the same hot path the O(n^2) ingest-OOM fix (d22b490) hardened.
 */

function makeEventsSink(): { events: SojournEvent[]; broadcast(e: SojournEvent): void } {
  const events: SojournEvent[] = [];
  return {
    events,
    broadcast(e: SojournEvent) {
      events.push(e);
    },
  };
}

/** A snapshotter whose ONLY real method is hasTree — controllable and
 * call-counted, so tests can drive validity and assert the git-probe count
 * (the scale regression guard). Everything else casts away: the graph route
 * touches nothing but hasTree. */
function makeStubSnapshotter(hasTreeImpl: (tree: string) => boolean): {
  snapshotter: SnapshotterLike;
  hasTreeCalls: string[];
} {
  const hasTreeCalls: string[] = [];
  const snapshotter = {
    hasTree: async (tree: string): Promise<boolean> => {
      hasTreeCalls.push(tree);
      return hasTreeImpl(tree); // may throw synchronously -> rejected promise
    },
  } as unknown as SnapshotterLike;
  return { snapshotter, hasTreeCalls };
}

describe("GET /api/projects/:id/graph — restorable (stubbed hasTree)", () => {
  let store: GraphStore;
  let flagEngine: FlagEngine;
  let sink: ReturnType<typeof makeEventsSink>;
  let fetchJson: FetchJson;
  let worktreesRoot: string;
  let ts = 0;

  beforeEach(() => {
    store = new GraphStore(":memory:");
    flagEngine = new FlagEngine();
    sink = makeEventsSink();
    fetchJson = vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson;
    worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-restorable-wt-"));
    ts = 0;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(worktreesRoot, { recursive: true, force: true });
  });

  function mkNode(
    projectId: string,
    id: string,
    parentId: string | null,
    snapshotRef: string | null,
  ): ChronoNode {
    const node: ChronoNode = {
      id,
      parentId,
      kind: "assistant",
      cli: "claude",
      sessionId: "s1",
      projectId,
      timestamp: new Date(1767225600000 + ++ts).toISOString(),
      snapshotRef,
      label: null,
      summary: "",
      content: { type: "text", text: "x" },
      meta: { nativeUuid: id },
    };
    store.upsertNode(node);
    return node;
  }

  function buildApp(snapshotter: SnapshotterLike): {
    app: ReturnType<typeof createApp>;
    snapshotterFor: (project: Project) => SnapshotterLike;
  } {
    const snapshotterFor = (_project: Project): SnapshotterLike => snapshotter;
    const restoreEngine = new RestoreEngine({ store, snapshotterFor, worktreesDir: worktreesRoot });
    const deps: ServerDeps = {
      store,
      snapshotterFor,
      flagEngine,
      restoreEngine,
      events: sink,
      version: "test-version",
      fetchJson,
    };
    return { app: createApp(deps), snapshotterFor };
  }

  async function graphNodes(
    app: ReturnType<typeof createApp>,
    projectId: string,
  ): Promise<Array<ChronoNode & { restorable: boolean }>> {
    const res = await request(app).get(`/api/projects/${encodeURIComponent(projectId)}/graph`);
    expect(res.status).toBe(200);
    return res.body.nodes;
  }

  it("own snapshotRef with a valid tree -> restorable true, and it equals preflight treeValid", async () => {
    const project = store.upsertProject("/tmp/restorable-a", "test");
    const node = mkNode(project.id, "claude:own-valid", null, "tree-valid");
    const { app } = buildApp(makeStubSnapshotter((t) => t === "tree-valid").snapshotter);

    const nodes = await graphNodes(app, project.id);
    const got = nodes.find((n) => n.id === node.id)!;
    expect(got.restorable).toBe(true);

    // Same node, same snapshotter -> preflight must agree.
    const pf = await request(app).post(`/api/nodes/${encodeURIComponent(node.id)}/preflight`).send();
    expect(pf.status).toBe(200);
    expect(pf.body.treeValid).toBe(true);
    expect(got.restorable).toBe(pf.body.treeValid);
  });

  it("own snapshotRef whose tree hasTree=false (thinned by gc) -> restorable false, equals preflight treeValid", async () => {
    const project = store.upsertProject("/tmp/restorable-b", "test");
    const node = mkNode(project.id, "claude:own-thinned", null, "tree-thinned");
    // hasTree returns false for everything -> the tree was pruned.
    const { app } = buildApp(makeStubSnapshotter(() => false).snapshotter);

    const nodes = await graphNodes(app, project.id);
    const got = nodes.find((n) => n.id === node.id)!;
    expect(got.restorable).toBe(false);

    const pf = await request(app).post(`/api/nodes/${encodeURIComponent(node.id)}/preflight`).send();
    expect(pf.status).toBe(200);
    expect(pf.body.treeValid).toBe(false);
    expect(got.restorable).toBe(pf.body.treeValid);
  });

  it("snapshotRef=null but a snapshotted ANCESTOR with a valid tree -> restorable true (inherited)", async () => {
    const project = store.upsertProject("/tmp/restorable-c", "test");
    const root = mkNode(project.id, "claude:anc-root", null, "tree-anc");
    const mid = mkNode(project.id, "claude:anc-mid", root.id, null);
    const leaf = mkNode(project.id, "claude:anc-leaf", mid.id, null);
    const { app } = buildApp(makeStubSnapshotter((t) => t === "tree-anc").snapshotter);

    const nodes = await graphNodes(app, project.id);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(root.id)!.restorable).toBe(true);
    expect(byId.get(mid.id)!.restorable).toBe(true);
    expect(byId.get(leaf.id)!.restorable).toBe(true);
  });

  it("no snapshot and no snapshotted ancestor -> restorable false (and hasTree never called)", async () => {
    const project = store.upsertProject("/tmp/restorable-d", "test");
    const root = mkNode(project.id, "claude:none-root", null, null);
    const leaf = mkNode(project.id, "claude:none-leaf", root.id, null);
    const stub = makeStubSnapshotter(() => true);
    const { app } = buildApp(stub.snapshotter);

    const nodes = await graphNodes(app, project.id);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(root.id)!.restorable).toBe(false);
    expect(byId.get(leaf.id)!.restorable).toBe(false);
    // No distinct effective tree exists -> no git probe at all.
    expect(stub.hasTreeCalls).toHaveLength(0);
  });

  it("hasTree throws for a tree -> nodes on that tree are restorable true (fail-open)", async () => {
    const project = store.upsertProject("/tmp/restorable-e", "test");
    const node = mkNode(project.id, "claude:throws", null, "tree-boom");
    const { app } = buildApp(
      makeStubSnapshotter(() => {
        throw new Error("transient git failure");
      }).snapshotter,
    );

    const nodes = await graphNodes(app, project.id);
    const got = nodes.find((n) => n.id === node.id)!;
    // Fail-open: a flaky probe must never grey out a real restore button.
    expect(got.restorable).toBe(true);
  });

  it("SCALE: ~2000 nodes sharing 5 distinct effective trees -> hasTree called at most (distinct trees), NOT ~2000", async () => {
    const project = store.upsertProject("/tmp/restorable-scale", "test");
    const DISTINCT = 5;
    const CHAIN_LEN = 400; // 5 * 400 = 2000 nodes total
    const deepLeaves: string[] = [];

    for (let r = 0; r < DISTINCT; r++) {
      const tree = `tree-${r}`;
      const rootId = `claude:scale-${r}-0`;
      mkNode(project.id, rootId, null, tree); // root carries the snapshot
      let parentId = rootId;
      for (let i = 1; i < CHAIN_LEN; i++) {
        const id = `claude:scale-${r}-${i}`;
        mkNode(project.id, id, parentId, null); // descendants inherit via ancestor walk
        parentId = id;
      }
      deepLeaves.push(parentId); // deepest node in this chain
    }

    const stub = makeStubSnapshotter(() => true);
    const { app } = buildApp(stub.snapshotter);

    const nodes = await graphNodes(app, project.id);
    expect(nodes).toHaveLength(DISTINCT * CHAIN_LEN);

    // The regression guard: one probe per DISTINCT effective tree, memoized
    // over the in-memory array — NOT one per node.
    expect(stub.hasTreeCalls.length).toBeLessThanOrEqual(DISTINCT);
    expect(stub.hasTreeCalls.length).toBe(DISTINCT);
    expect(new Set(stub.hasTreeCalls).size).toBe(DISTINCT);

    // Deep descendants still inherit their root's (valid) tree.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const leafId of deepLeaves) {
      expect(byId.get(leafId)!.restorable).toBe(true);
    }
  });
});

describe("GET /api/projects/:id/graph — restorable equals preflight over a REAL shadow snapshotter", () => {
  let projectRoot: string;
  let shadowRoot: string;
  let worktreesRoot: string;
  let store: GraphStore;
  let flagEngine: FlagEngine;
  let sink: ReturnType<typeof makeEventsSink>;
  let fetchJson: FetchJson;
  let app: ReturnType<typeof createApp>;
  let project: Project;
  let realTree: string;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-restorable-real-project-"));
    shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-restorable-real-shadow-"));
    worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-restorable-real-wt-"));

    fs.writeFileSync(path.join(projectRoot, "a.txt"), "v1");

    const snapshotter = new ShadowSnapshotter({ projectRoot, shadowDir: shadowRoot });
    await snapshotter.init();
    realTree = await snapshotter.snapshot();

    store = new GraphStore(":memory:");
    flagEngine = new FlagEngine();
    sink = makeEventsSink();
    fetchJson = vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson;

    project = store.upsertProject(projectRoot, "test");
    const snapshotterFor = (_project: Project): SnapshotterLike => snapshotter;
    const restoreEngine = new RestoreEngine({ store, snapshotterFor, worktreesDir: worktreesRoot });
    const deps: ServerDeps = {
      store,
      snapshotterFor,
      flagEngine,
      restoreEngine,
      events: sink,
      version: "test-version",
      fetchJson,
    };
    app = createApp(deps);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(shadowRoot, { recursive: true, force: true });
    fs.rmSync(worktreesRoot, { recursive: true, force: true });
  });

  function mkNode(id: string, snapshotRef: string | null): ChronoNode {
    const node: ChronoNode = {
      id,
      parentId: null,
      kind: "assistant",
      cli: "claude",
      sessionId: "s-real",
      projectId: project.id,
      timestamp: "2026-01-01T00:00:00.000Z",
      snapshotRef,
      label: null,
      summary: "",
      content: { type: "text", text: "done" },
      meta: { nativeUuid: id },
    };
    store.upsertNode(node);
    return node;
  }

  it("a real snapshotted tree -> restorable true AND preflight treeValid true (identical)", async () => {
    const node = mkNode("claude:real-valid", realTree);

    const graph = await request(app).get(`/api/projects/${encodeURIComponent(project.id)}/graph`);
    expect(graph.status).toBe(200);
    const got = graph.body.nodes.find((n: { id: string }) => n.id === node.id);
    expect(got.restorable).toBe(true);

    const pf = await request(app).post(`/api/nodes/${encodeURIComponent(node.id)}/preflight`).send();
    expect(pf.status).toBe(200);
    expect(pf.body.treeValid).toBe(true);
    expect(got.restorable).toBe(pf.body.treeValid);
  });

  it("a nonexistent tree -> restorable false AND preflight treeValid false (identical)", async () => {
    // A syntactically-valid but absent tree hash: hasTree() runs `git
    // cat-file -t` which exits non-zero -> false, exactly as after gc pruned it.
    const node = mkNode("claude:real-bogus", "1111111111111111111111111111111111111111");

    const graph = await request(app).get(`/api/projects/${encodeURIComponent(project.id)}/graph`);
    expect(graph.status).toBe(200);
    const got = graph.body.nodes.find((n: { id: string }) => n.id === node.id);
    expect(got.restorable).toBe(false);

    const pf = await request(app).post(`/api/nodes/${encodeURIComponent(node.id)}/preflight`).send();
    expect(pf.status).toBe(200);
    expect(pf.body.treeValid).toBe(false);
    expect(got.restorable).toBe(pf.body.treeValid);
  });
});
