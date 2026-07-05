import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphStore, ShadowSnapshotter, FlagEngine } from "@sojourn/core";
import type { ChronoNode, FetchJson, IngestBatch, Project, SnapshotterLike } from "@sojourn/core";
import { parseSessionJsonl } from "@sojourn/adapter-claude";
import { ingestBatch, type IngestDeps } from "../src/ingest.js";
import type { SojournEvent } from "../src/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  __dirname,
  "..",
  "..",
  "adapter-claude",
  "test",
  "fixtures",
  "sample-session.jsonl",
);
const fixtureRaw = fs.readFileSync(fixturePath, "utf8");

function makeEventsSink(): { events: SojournEvent[]; broadcast(e: SojournEvent): void } {
  const events: SojournEvent[] = [];
  return {
    events,
    broadcast(e: SojournEvent) {
      events.push(e);
    },
  };
}

describe("ingestBatch", () => {
  let projectRoot: string;
  let shadowRoot: string;
  let store: GraphStore;
  let flagEngine: FlagEngine;
  let sink: ReturnType<typeof makeEventsSink>;
  let fetchJson: FetchJson;
  let snapshotters: Map<string, SnapshotterLike>;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-ingest-project-"));
    shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-ingest-shadow-"));
    store = new GraphStore(":memory:");
    flagEngine = new FlagEngine();
    sink = makeEventsSink();
    fetchJson = vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson;
    snapshotters = new Map();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(shadowRoot, { recursive: true, force: true });
  });

  function makeDeps(): IngestDeps {
    return {
      store,
      flagEngine,
      events: sink,
      fetchJson,
      snapshotterFor(project: Project): SnapshotterLike {
        const existing = snapshotters.get(project.id);
        if (existing) return existing;
        const snapshotter = new ShadowSnapshotter({
          projectRoot: project.root,
          shadowDir: path.join(shadowRoot, project.id),
        });
        snapshotters.set(project.id, snapshotter);
        return snapshotter;
      },
    };
  }

  it("upserts project, session, and nodes from the adapter-claude fixture", async () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    // Point the batch at a real tmp dir so on-disk existence checks pass.
    batch.project.root = projectRoot;

    const deps = makeDeps();
    const result = await ingestBatch(deps, batch);

    expect(result.added.length).toBe(batch.nodes.length);

    const projects = store.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].root).toBe(projectRoot);

    const sessions = store.getSessions(projects[0].id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("session-abc");

    const graph = store.getGraph(projects[0].id);
    expect(graph.length).toBe(batch.nodes.length);
    for (const node of graph) {
      expect(node.projectId).toBe(projects[0].id);
    }
  });

  it("is idempotent — re-ingesting the same batch adds no new nodes the second time", async () => {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    batch.project.root = projectRoot;
    const deps = makeDeps();

    const first = await ingestBatch(deps, batch);
    expect(first.added.length).toBe(batch.nodes.length);

    const second = await ingestBatch(deps, batch);
    expect(second.added.length).toBe(0);

    const projects = store.getProjects();
    const graph = store.getGraph(projects[0].id);
    expect(graph.length).toBe(batch.nodes.length);
  });

  it("takes exactly one snapshot per batch and sets snapshotRef on the last new node", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");

    const node1: ChronoNode = {
      id: "claude:n1",
      parentId: null,
      kind: "prompt",
      cli: "claude",
      sessionId: "s1",
      projectId: "",
      timestamp: "2026-01-01T00:00:00.000Z",
      snapshotRef: null,
      label: null,
      summary: "hi",
      content: "hi",
      meta: { nativeUuid: "n1" },
    };
    const node2: ChronoNode = {
      id: "claude:n2",
      parentId: "claude:n1",
      kind: "assistant",
      cli: "claude",
      sessionId: "s1",
      projectId: "",
      timestamp: "2026-01-01T00:00:01.000Z",
      snapshotRef: null,
      label: null,
      summary: "done",
      content: { type: "text", text: "Hello, how can I help?" },
      meta: { nativeUuid: "n2" },
    };

    const batch: IngestBatch = {
      project: { root: projectRoot, name: "test" },
      session: { id: "s1", cli: "claude" },
      nodes: [node1, node2],
    };

    const deps = makeDeps();
    await ingestBatch(deps, batch);

    const stored2 = store.getNode("claude:n2")!;
    expect(stored2.snapshotRef).not.toBeNull();

    const stored1 = store.getNode("claude:n1")!;
    expect(stored1.snapshotRef).toBeNull();
  });

  it("does NOT snapshot when the project root does not exist on disk", async () => {
    const batch: IngestBatch = {
      project: { root: "/this/does/not/exist/anywhere", name: "ghost" },
      session: { id: "s-ghost", cli: "claude" },
      nodes: [
        {
          id: "claude:ghost1",
          parentId: null,
          kind: "assistant",
          cli: "claude",
          sessionId: "s-ghost",
          projectId: "",
          timestamp: "2026-01-01T00:00:00.000Z",
          snapshotRef: null,
          label: null,
          summary: "hi",
          content: { type: "text", text: "hi there" },
          meta: { nativeUuid: "ghost1" },
        },
      ],
    };

    const deps = makeDeps();
    await expect(ingestBatch(deps, batch)).resolves.toEqual({ added: ["claude:ghost1"] });

    const stored = store.getNode("claude:ghost1")!;
    expect(stored.snapshotRef).toBeNull();
  });

  it("runs T1 checks on new assistant nodes and stores flags (edit claim with no diff)", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");

    // Seed a prior assistant node with its own snapshot so the flagged
    // node's parentTree resolves to a real (non-null) tree — the T1 checks
    // that need ground truth (edit_claim_mismatch, file_ref_missing,
    // symbol_not_found) all stay silent when parentTree/nodeTree is null.
    const priorNode: ChronoNode = {
      id: "claude:prior",
      parentId: null,
      kind: "assistant",
      cli: "claude",
      sessionId: "s-flag",
      projectId: "",
      timestamp: "2026-01-01T00:00:00.000Z",
      snapshotRef: null,
      label: null,
      summary: "",
      content: { type: "text", text: "Sure, I'll look into it." },
      meta: { nativeUuid: "prior" },
    };
    const firstBatch: IngestBatch = {
      project: { root: projectRoot, name: "test" },
      session: { id: "s-flag", cli: "claude" },
      nodes: [priorNode],
    };
    const deps = makeDeps();
    await ingestBatch(deps, firstBatch);
    expect(store.getNode("claude:prior")!.snapshotRef).not.toBeNull();

    const node: ChronoNode = {
      id: "claude:flagme",
      parentId: "claude:prior",
      kind: "assistant",
      cli: "claude",
      sessionId: "s-flag",
      projectId: "",
      timestamp: "2026-01-01T00:00:01.000Z",
      snapshotRef: null,
      label: null,
      summary: "",
      content: { type: "text", text: "I updated `auth.py` to handle refresh tokens." },
      meta: { nativeUuid: "flagme" },
    };

    const secondBatch: IngestBatch = {
      project: { root: projectRoot, name: "test" },
      session: { id: "s-flag", cli: "claude" },
      nodes: [priorNode, node],
    };
    await ingestBatch(deps, secondBatch);

    const stored = store.getNode("claude:flagme")!;
    expect(stored.flags && stored.flags.length).toBeGreaterThan(0);
    expect(stored.flags?.some((f) => f.kind === "edit_claim_mismatch")).toBe(true);
  });

  it("emits node_added for each new node and project_updated once", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");
    const batch: IngestBatch = {
      project: { root: projectRoot, name: "test" },
      session: { id: "s-events", cli: "claude" },
      nodes: [
        {
          id: "claude:ev1",
          parentId: null,
          kind: "prompt",
          cli: "claude",
          sessionId: "s-events",
          projectId: "",
          timestamp: "2026-01-01T00:00:00.000Z",
          snapshotRef: null,
          label: null,
          summary: "hi",
          content: "hi",
          meta: { nativeUuid: "ev1" },
        },
      ],
    };
    const deps = makeDeps();
    await ingestBatch(deps, batch);

    const nodeAdded = sink.events.filter((e) => e.type === "node_added");
    const projectUpdated = sink.events.filter((e) => e.type === "project_updated");
    expect(nodeAdded).toHaveLength(1);
    expect(projectUpdated).toHaveLength(1);
  });

  it("never throws even when a node's content is unserializable (circular reference)", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const goodNode: ChronoNode = {
      id: "claude:good1",
      parentId: null,
      kind: "prompt",
      cli: "claude",
      sessionId: "s-bad",
      projectId: "",
      timestamp: "2026-01-01T00:00:00.000Z",
      snapshotRef: null,
      label: null,
      summary: "hi",
      content: "hi",
      meta: { nativeUuid: "good1" },
    };
    const badNode: ChronoNode = {
      id: "claude:bad1",
      parentId: "claude:good1",
      kind: "assistant",
      cli: "claude",
      sessionId: "s-bad",
      projectId: "",
      timestamp: "2026-01-01T00:00:01.000Z",
      snapshotRef: null,
      label: null,
      summary: "",
      content: circular,
      meta: { nativeUuid: "bad1" },
    };

    const batch: IngestBatch = {
      project: { root: projectRoot, name: "test" },
      session: { id: "s-bad", cli: "claude" },
      nodes: [goodNode, badNode],
    };
    const deps = makeDeps();
    const result = await ingestBatch(deps, batch);

    // the bad node's upsert threw (circular JSON.stringify) and was caught;
    // the good node before it still made it in.
    expect(result.added).toContain("claude:good1");
    expect(result.added).not.toContain("claude:bad1");
    expect(store.getNode("claude:bad1")).toBeNull();
    expect(store.getNode("claude:good1")).not.toBeNull();
  });
});
