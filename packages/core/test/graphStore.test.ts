import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/store/index.js";
import type { ChronoNode, Flag } from "../src/types.js";

function makeNode(overrides: Partial<ChronoNode> = {}): ChronoNode {
  const nativeUuid = overrides.meta?.nativeUuid ?? "uuid-1";
  return {
    id: `claude:${nativeUuid}`,
    parentId: null,
    kind: "prompt",
    cli: "claude",
    sessionId: "session-1",
    projectId: "project-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: "a summary",
    content: { text: "hello" },
    meta: { nativeUuid },
    ...overrides,
  };
}

describe("GraphStore", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("projects", () => {
    it("upsertProject is idempotent: same root yields same id", () => {
      const p1 = store.upsertProject("/repo/a", "Repo A");
      const p2 = store.upsertProject("/repo/a", "Repo A renamed");
      expect(p2.id).toBe(p1.id);
      expect(store.getProjects()).toHaveLength(1);
    });

    it("different roots yield different ids", () => {
      const p1 = store.upsertProject("/repo/a");
      const p2 = store.upsertProject("/repo/b");
      expect(p1.id).not.toBe(p2.id);
    });

    it("getProject returns null for unknown id", () => {
      expect(store.getProject("nope")).toBeNull();
    });

    it("getProject returns the project by id", () => {
      const p1 = store.upsertProject("/repo/a", "Repo A");
      const found = store.getProject(p1.id);
      expect(found).toEqual(p1);
    });
  });

  describe("sessions", () => {
    it("upserts and lists sessions for a project", () => {
      const p = store.upsertProject("/repo/a");
      store.upsertSession({ id: "s1", projectId: p.id, cli: "claude", title: "first" });
      store.upsertSession({ id: "s2", projectId: p.id, cli: "opencode" });
      const sessions = store.getSessions(p.id);
      expect(sessions).toHaveLength(2);
      expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    });

    it("upsertSession is idempotent by id", () => {
      const p = store.upsertProject("/repo/a");
      store.upsertSession({ id: "s1", projectId: p.id, cli: "claude", title: "first" });
      store.upsertSession({ id: "s1", projectId: p.id, cli: "claude", title: "updated" });
      const sessions = store.getSessions(p.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].title).toBe("updated");
    });
  });

  describe("nodes", () => {
    it("upserts a node and round-trips fields via getNode", () => {
      const node = makeNode();
      store.upsertNode(node);
      const found = store.getNode(node.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(node.id);
      expect(found!.kind).toBe("prompt");
      expect(found!.summary).toBe("a summary");
      expect(found!.content).toEqual({ text: "hello" });
      expect(found!.meta).toEqual({ nativeUuid: "uuid-1" });
      expect(found!.snapshotRef).toBeNull();
    });

    it("getNode returns null for unknown id", () => {
      expect(store.getNode("claude:doesnotexist")).toBeNull();
    });

    it("upsertNode is idempotent by id: re-upsert updates fields", () => {
      const node = makeNode({ summary: "first" });
      store.upsertNode(node);
      store.upsertNode({ ...node, summary: "second" });
      const found = store.getNode(node.id);
      expect(found!.summary).toBe("second");
      // ensure no duplicate rows were created
      expect(store.getGraph("project-1")).toHaveLength(1);
    });

    it("upsertNode preserves existing snapshotRef when incoming is null", () => {
      const node = makeNode({ snapshotRef: "tree-abc" });
      store.upsertNode(node);
      store.upsertNode({ ...node, snapshotRef: null, summary: "updated" });
      const found = store.getNode(node.id);
      expect(found!.snapshotRef).toBe("tree-abc");
      expect(found!.summary).toBe("updated");
    });

    it("upsertNode overwrites snapshotRef when incoming is non-null", () => {
      const node = makeNode({ snapshotRef: "tree-abc" });
      store.upsertNode(node);
      store.upsertNode({ ...node, snapshotRef: "tree-def" });
      const found = store.getNode(node.id);
      expect(found!.snapshotRef).toBe("tree-def");
    });

    it("round-trips parent/children including two siblings under one parent", () => {
      const parent = makeNode({
        id: "claude:parent",
        meta: { nativeUuid: "parent" },
      });
      const childA = makeNode({
        id: "claude:childA",
        parentId: parent.id,
        meta: { nativeUuid: "childA" },
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const childB = makeNode({
        id: "claude:childB",
        parentId: parent.id,
        meta: { nativeUuid: "childB" },
        timestamp: "2026-01-01T00:00:02.000Z",
      });
      store.upsertNode(parent);
      store.upsertNode(childA);
      store.upsertNode(childB);

      const children = store.getChildren(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id).sort()).toEqual(["claude:childA", "claude:childB"]);
      expect(children[0].parentId).toBe(parent.id);
      expect(children[1].parentId).toBe(parent.id);
    });

    it("getGraph returns all nodes for a project in chronological order", () => {
      const n1 = makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, timestamp: "2026-01-01T00:00:03.000Z" });
      const n2 = makeNode({ id: "claude:n2", meta: { nativeUuid: "n2" }, timestamp: "2026-01-01T00:00:01.000Z" });
      const n3 = makeNode({ id: "claude:n3", meta: { nativeUuid: "n3" }, timestamp: "2026-01-01T00:00:02.000Z" });
      store.upsertNode(n1);
      store.upsertNode(n2);
      store.upsertNode(n3);

      const graph = store.getGraph("project-1");
      expect(graph.map((n) => n.id)).toEqual(["claude:n2", "claude:n3", "claude:n1"]);
    });

    it("getGraph only returns nodes for the given project", () => {
      store.upsertNode(makeNode({ id: "claude:pa", meta: { nativeUuid: "pa" }, projectId: "project-1" }));
      store.upsertNode(makeNode({ id: "claude:pb", meta: { nativeUuid: "pb" }, projectId: "project-2" }));
      const graph = store.getGraph("project-1");
      expect(graph.map((n) => n.id)).toEqual(["claude:pa"]);
    });

    it("getSessionNodes returns nodes for a session in chronological order", () => {
      const n1 = makeNode({
        id: "claude:s1a",
        meta: { nativeUuid: "s1a" },
        sessionId: "sessA",
        timestamp: "2026-01-01T00:00:02.000Z",
      });
      const n2 = makeNode({
        id: "claude:s1b",
        meta: { nativeUuid: "s1b" },
        sessionId: "sessA",
        timestamp: "2026-01-01T00:00:01.000Z",
      });
      const other = makeNode({
        id: "claude:s2a",
        meta: { nativeUuid: "s2a" },
        sessionId: "sessB",
        timestamp: "2026-01-01T00:00:00.500Z",
      });
      store.upsertNode(n1);
      store.upsertNode(n2);
      store.upsertNode(other);

      const nodes = store.getSessionNodes("sessA");
      expect(nodes.map((n) => n.id)).toEqual(["claude:s1b", "claude:s1a"]);
    });

    it("latestNode returns the most recent node in a session by timestamp", () => {
      store.upsertNode(
        makeNode({ id: "claude:l1", meta: { nativeUuid: "l1" }, sessionId: "sessL", timestamp: "2026-01-01T00:00:01.000Z" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:l2", meta: { nativeUuid: "l2" }, sessionId: "sessL", timestamp: "2026-01-01T00:00:03.000Z" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:l3", meta: { nativeUuid: "l3" }, sessionId: "sessL", timestamp: "2026-01-01T00:00:02.000Z" }),
      );
      const latest = store.latestNode("sessL");
      expect(latest?.id).toBe("claude:l2");
    });

    it("latestNode breaks timestamp ties by rowid (insertion order)", () => {
      const ts = "2026-01-01T00:00:05.000Z";
      store.upsertNode(makeNode({ id: "claude:t1", meta: { nativeUuid: "t1" }, sessionId: "sessT", timestamp: ts }));
      store.upsertNode(makeNode({ id: "claude:t2", meta: { nativeUuid: "t2" }, sessionId: "sessT", timestamp: ts }));
      const latest = store.latestNode("sessT");
      expect(latest?.id).toBe("claude:t2");
    });

    it("latestNode returns null when session has no nodes", () => {
      expect(store.latestNode("nope")).toBeNull();
    });

    it("setSnapshotRef updates a node's snapshotRef", () => {
      const node = makeNode();
      store.upsertNode(node);
      store.setSnapshotRef(node.id, "tree-xyz");
      const found = store.getNode(node.id);
      expect(found!.snapshotRef).toBe("tree-xyz");
    });

    it("round-trips forkedFrom in meta", () => {
      const node = makeNode({ meta: { nativeUuid: "fork-1", forkedFrom: "claude:origin" } });
      store.upsertNode(node);
      const found = store.getNode(node.id);
      expect(found!.meta).toEqual({ nativeUuid: "fork-1", forkedFrom: "claude:origin" });
    });
  });

  describe("flags", () => {
    const flag: Flag = {
      kind: "possible_hallucination",
      tier: "advisory",
      confidence: "medium",
      evidence: "some evidence string",
      source: "llm_critic",
    };

    it("addFlag attaches a flag to a node and getFlags returns it", () => {
      const node = makeNode();
      store.upsertNode(node);
      const stored = store.addFlag(node.id, flag);
      expect(stored.id).toBeGreaterThan(0);
      expect(stored.nodeId).toBe(node.id);
      expect(stored.kind).toBe(flag.kind);
      expect(stored.dismissed).toBe(false);

      const flags = store.getFlags(node.id);
      expect(flags).toHaveLength(1);
      expect(flags[0]).toEqual(stored);
    });

    it("dedups identical (node, kind, evidence) flags", () => {
      const node = makeNode();
      store.upsertNode(node);
      store.addFlag(node.id, flag);
      store.addFlag(node.id, flag);
      expect(store.getFlags(node.id)).toHaveLength(1);
    });

    it("allows distinct evidence for the same kind on the same node", () => {
      const node = makeNode();
      store.upsertNode(node);
      store.addFlag(node.id, flag);
      store.addFlag(node.id, { ...flag, evidence: "different evidence" });
      expect(store.getFlags(node.id)).toHaveLength(2);
    });

    it("resolveFlag sets auto_resolved / autoResolved", () => {
      const node = makeNode();
      store.upsertNode(node);
      const stored = store.addFlag(node.id, flag);
      store.resolveFlag(stored.id);
      const [found] = store.getFlags(node.id);
      expect(found.autoResolved).toBe(true);
    });

    it("dismissFlag sets dismissed", () => {
      const node = makeNode();
      store.upsertNode(node);
      const stored = store.addFlag(node.id, flag);
      store.dismissFlag(stored.id);
      const [found] = store.getFlags(node.id);
      expect(found.dismissed).toBe(true);
    });

    it("getNode attaches flags to the node", () => {
      const node = makeNode();
      store.upsertNode(node);
      store.addFlag(node.id, flag);
      const found = store.getNode(node.id);
      expect(found!.flags).toHaveLength(1);
      expect(found!.flags![0].kind).toBe(flag.kind);
    });

    it("getGraph attaches flags to each node", () => {
      const node = makeNode();
      store.upsertNode(node);
      store.addFlag(node.id, flag);
      const graph = store.getGraph("project-1");
      expect(graph[0].flags).toHaveLength(1);
      expect(graph[0].flags![0].evidence).toBe(flag.evidence);
    });
  });

  describe("annotations", () => {
    it("addAnnotation attaches an annotation to a node", () => {
      const node = makeNode();
      store.upsertNode(node);
      const annotation = store.addAnnotation(node.id, "a note");
      expect(annotation.id).toBeGreaterThan(0);
      expect(annotation.nodeId).toBe(node.id);
      expect(annotation.text).toBe("a note");
    });

    it("getNode attaches annotations to the node", () => {
      const node = makeNode();
      store.upsertNode(node);
      store.addAnnotation(node.id, "note one");
      store.addAnnotation(node.id, "note two");
      const found = store.getNode(node.id);
      expect(found!.annotations).toHaveLength(2);
      expect(found!.annotations!.map((a) => a.text).sort()).toEqual(["note one", "note two"]);
    });
  });
});
