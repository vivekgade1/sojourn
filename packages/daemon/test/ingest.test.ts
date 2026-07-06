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

  /** Builds a bare ChronoNode for hand-rolled batches in these tests. */
  function node(
    id: string,
    parentId: string | null,
    kind: ChronoNode["kind"],
    sessionId: string,
    timestamp: string,
    content: unknown,
  ): ChronoNode {
    return {
      id: `claude:${id}`,
      parentId: parentId === null ? null : `claude:${parentId}`,
      kind,
      cli: "claude",
      sessionId,
      projectId: "",
      timestamp,
      snapshotRef: null,
      label: null,
      summary: "",
      content,
      meta: { nativeUuid: id },
    };
  }

  it("runs T1 checks on new assistant nodes and stores flags (untruthful edit claim, empty turn diff)", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");
    const deps = makeDeps();
    const sess = "s-flag";

    // Turn 1: prompt + assistant reply — the assistant node anchors snapshot
    // S1, which becomes the "turn base" for the NEXT turn's claims.
    const prompt1 = node("p1", null, "prompt", sess, "2026-01-01T00:00:00.000Z", "please fix auth");
    const prior = node("prior", "p1", "assistant", sess, "2026-01-01T00:00:01.000Z", {
      type: "text",
      text: "Sure, I'll look into it.",
    });
    await ingestBatch(deps, {
      project: { root: projectRoot, name: "test" },
      session: { id: sess, cli: "claude" },
      nodes: [prompt1, prior],
    });
    expect(store.getNode("claude:prior")!.snapshotRef).not.toBeNull();

    // Turn 2: a new prompt then an assistant claim — but NOTHING on disk
    // changed anywhere in this turn, so the claim is untruthful and must
    // flag (true positive: claim with no edit anywhere in the turn).
    const prompt2 = node("p2", "prior", "prompt", sess, "2026-01-01T00:00:02.000Z", "and refresh tokens?");
    const claim = node("flagme", "p2", "assistant", sess, "2026-01-01T00:00:03.000Z", {
      type: "text",
      text: "I updated `auth.py` to handle refresh tokens.",
    });
    await ingestBatch(deps, {
      project: { root: projectRoot, name: "test" },
      session: { id: sess, cli: "claude" },
      nodes: [prompt1, prior, prompt2, claim],
    });

    const stored = store.getNode("claude:flagme")!;
    expect(stored.flags && stored.flags.length).toBeGreaterThan(0);
    expect(stored.flags?.some((f) => f.kind === "edit_claim_mismatch")).toBe(true);
  });

  it("does NOT flag a truthful edit claim that arrives in a later batch than the edit (turn-scoped grounding)", async () => {
    await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");
    const deps = makeDeps();
    const sess = "s-truthful";

    // Turn 1 (setup): prompt + assistant reply anchors snapshot S1 — the
    // state BEFORE the interesting turn.
    const prompt1 = node("t-p1", null, "prompt", sess, "2026-01-01T00:00:00.000Z", "hi");
    const prior = node("t-prior", "t-p1", "assistant", sess, "2026-01-01T00:00:01.000Z", {
      type: "text",
      text: "Hello! What should I do?",
    });
    await ingestBatch(deps, {
      project: { root: projectRoot, name: "test" },
      session: { id: sess, cli: "claude" },
      nodes: [prompt1, prior],
    });

    // The REAL edit happens during turn 2, before the Edit tool_result's
    // batch is ingested.
    await fsp.writeFile(path.join(projectRoot, "auth.py"), "def refresh(): pass\n");

    // Batch A (debounced watcher batch #1): prompt + tool_use + tool_result.
    // The tool_result anchors snapshot S2 (which contains auth.py).
    const prompt2 = node("t-p2", "t-prior", "prompt", sess, "2026-01-01T00:00:02.000Z", "fix auth.py");
    const toolUse = node("t-tu", "t-p2", "tool_use", sess, "2026-01-01T00:00:03.000Z", {
      name: "Edit",
      input: { file_path: "auth.py" },
    });
    const toolResult = node("t-tr", "t-tu", "tool_result", sess, "2026-01-01T00:00:04.000Z", {
      content: "ok",
    });
    await ingestBatch(deps, {
      project: { root: projectRoot, name: "test" },
      session: { id: sess, cli: "claude" },
      nodes: [prompt1, prior, prompt2, toolUse, toolResult],
    });
    expect(store.getNode("claude:t-tr")!.snapshotRef).not.toBeNull();

    // Batch B (debounced watcher batch #2, ~300ms later): the assistant's
    // TRUTHFUL claim. No files changed since batch A, so a naive
    // previous-snapshot diff would be empty — but the turn-scoped diff
    // (from the snapshot before this turn's prompt) contains auth.py.
    const claim = node("t-claim", "t-tr", "assistant", sess, "2026-01-01T00:00:05.000Z", {
      type: "text",
      text: "I updated `auth.py` to handle refresh tokens.",
    });
    await ingestBatch(deps, {
      project: { root: projectRoot, name: "test" },
      session: { id: sess, cli: "claude" },
      nodes: [prompt1, prior, prompt2, toolUse, toolResult, claim],
    });

    const stored = store.getNode("claude:t-claim")!;
    const editClaimFlags = (stored.flags ?? []).filter((f) => f.kind === "edit_claim_mismatch");
    expect(editClaimFlags).toEqual([]);
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
