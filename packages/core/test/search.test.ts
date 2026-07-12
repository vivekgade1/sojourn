import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../src/store/index.js";
import type { ChronoNode } from "../src/types.js";

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

describe("GraphStore.search", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("full-text search (q)", () => {
    it("finds a node by summary text", () => {
      store.upsertNode(
        makeNode({
          id: "claude:n1",
          meta: { nativeUuid: "n1" },
          summary: "decided to use SQLite for the graph store",
        }),
      );
      store.upsertNode(
        makeNode({
          id: "claude:n2",
          meta: { nativeUuid: "n2" },
          summary: "unrelated turn about the CLI",
        }),
      );

      const hits = store.search("project-1", { q: "SQLite" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
      expect(hits[0].snippet.length).toBeGreaterThan(0);
    });

    it("finds a node by label text", () => {
      store.upsertNode(
        makeNode({
          id: "claude:n1",
          meta: { nativeUuid: "n1" },
          label: "checkpoint: migration-framework",
          summary: "nothing notable here",
        }),
      );

      const hits = store.search("project-1", { q: "migration-framework" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("finds annotation text added AFTER the node was created", () => {
      const node = makeNode({
        id: "claude:n1",
        meta: { nativeUuid: "n1" },
        summary: "plain turn, nothing special",
      });
      store.upsertNode(node);

      // not findable yet
      expect(store.search("project-1", { q: "narwhal" })).toEqual([]);

      store.addAnnotation(node.id, "flagged: this touches the narwhal subsystem");

      const hits = store.search("project-1", { q: "narwhal" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("re-upserting a node after annotating it does not drop the annotation from the index", () => {
      const node = makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, summary: "first" });
      store.upsertNode(node);
      store.addAnnotation(node.id, "mentions okapi somewhere");

      // simulate a later re-ingest of the same node (e.g. summary refined)
      store.upsertNode({ ...node, summary: "first, refined" });

      const hits = store.search("project-1", { q: "okapi" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("is case-insensitive", () => {
      store.upsertNode(
        makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, summary: "Uses ZSTD compression" }),
      );
      const hits = store.search("project-1", { q: "zstd" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("orders hits by score descending (best match first)", () => {
      store.upsertNode(
        makeNode({
          id: "claude:weak",
          meta: { nativeUuid: "weak" },
          summary: "graph store notes mention snapshot once",
        }),
      );
      store.upsertNode(
        makeNode({
          id: "claude:strong",
          meta: { nativeUuid: "strong" },
          summary: "snapshot snapshot snapshot: the snapshot of the snapshot",
        }),
      );

      const hits = store.search("project-1", { q: "snapshot" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:strong", "claude:weak"]);
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      // scores strictly descending across the whole result set
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
      }
    });

    it("returns [] for a query that matches nothing, without throwing", () => {
      store.upsertNode(makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" } }));
      expect(store.search("project-1", { q: "zzz-nonexistent-token" })).toEqual([]);
    });

    it("guards against FTS5 injection syntax (quotes / OR / NEAR) — no throw, no over-match", () => {
      store.upsertNode(
        makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, summary: "totally unrelated content" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:n2", meta: { nativeUuid: "n2" }, summary: "another unrelated turn" }),
      );

      const attempts = [
        'foo" OR "1"="1',
        'a OR b',
        'a NEAR/2 b',
        '"unterminated',
        'summary:foo OR summary:bar',
        '*',
        '^weird',
      ];

      for (const q of attempts) {
        expect(() => store.search("project-1", { q })).not.toThrow();
        // none of these should be interpreted as boolean/wildcard operators
        // that vacuum up every row — they're literal text nobody's content
        // contains, so the honest result is zero hits.
        expect(store.search("project-1", { q })).toEqual([]);
      }
    });

    it("q of only whitespace behaves like no q (does not throw, does not FTS-match everything)", () => {
      store.upsertNode(makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" } }));
      expect(() => store.search("project-1", { q: "   " })).not.toThrow();
    });
  });

  describe("file search", () => {
    it("returns nodes indexed for an exact path", () => {
      store.upsertNode(makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" } }));
      store.upsertNode(makeNode({ id: "claude:n2", meta: { nativeUuid: "n2" } }));
      store.indexNodeFiles("claude:n1", [{ path: "packages/core/src/store/graphStore.ts", status: "M" }]);
      store.indexNodeFiles("claude:n2", [{ path: "packages/cli/src/program.ts", status: "M" }]);

      const hits = store.search("project-1", { file: "packages/core/src/store/graphStore.ts" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("returns nodes indexed for a basename suffix match", () => {
      store.upsertNode(makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" } }));
      store.indexNodeFiles("claude:n1", [{ path: "packages/core/src/store/graphStore.ts", status: "M" }]);

      const hits = store.search("project-1", { file: "graphStore.ts" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("does not match an unrelated file", () => {
      store.upsertNode(makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" } }));
      store.indexNodeFiles("claude:n1", [{ path: "packages/core/src/store/graphStore.ts", status: "M" }]);

      expect(store.search("project-1", { file: "unrelated.ts" })).toEqual([]);
    });

    it("indexNodeFiles replaces prior rows for the node rather than accumulating", () => {
      store.upsertNode(makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" } }));
      store.indexNodeFiles("claude:n1", [{ path: "a.ts", status: "M" }]);
      store.indexNodeFiles("claude:n1", [{ path: "b.ts", status: "A" }]);

      expect(store.search("project-1", { file: "a.ts" })).toEqual([]);
      expect(store.search("project-1", { file: "b.ts" }).map((h) => h.node.id)).toEqual([
        "claude:n1",
      ]);
    });

    it("q-less file-only query works", () => {
      store.upsertNode(makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, summary: "s" }));
      store.indexNodeFiles("claude:n1", [{ path: "src/thing.ts", status: "M" }]);
      const hits = store.search("project-1", { file: "src/thing.ts" });
      expect(hits).toHaveLength(1);
      expect(hits[0].node.id).toBe("claude:n1");
    });
  });

  describe("kinds filter", () => {
    it("filters results to the given node kinds", () => {
      store.upsertNode(
        makeNode({ id: "claude:d1", meta: { nativeUuid: "d1" }, kind: "decision", summary: "picked sqlite" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:p1", meta: { nativeUuid: "p1" }, kind: "prompt", summary: "picked sqlite too" }),
      );

      const hits = store.search("project-1", { kinds: ["decision"] });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:d1"]);
    });

    it("combines with q", () => {
      store.upsertNode(
        makeNode({ id: "claude:d1", meta: { nativeUuid: "d1" }, kind: "decision", summary: "chose betterSqlite3" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:a1", meta: { nativeUuid: "a1" }, kind: "assumption", summary: "assumed betterSqlite3 works" }),
      );

      const hits = store.search("project-1", { q: "betterSqlite3", kinds: ["decision"] });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:d1"]);
    });
  });

  describe("q + file conjunction", () => {
    it("requires both the text match and the file match", () => {
      store.upsertNode(
        makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, summary: "refactored the parser" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:n2", meta: { nativeUuid: "n2" }, summary: "refactored the parser" }),
      );
      store.indexNodeFiles("claude:n1", [{ path: "adapter-claude/src/parser.ts", status: "M" }]);
      store.indexNodeFiles("claude:n2", [{ path: "adapter-opencode/src/parser.ts", status: "M" }]);

      const hits = store.search("project-1", {
        q: "refactored",
        file: "adapter-claude/src/parser.ts",
      });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("returns [] when the text matches but the file doesn't", () => {
      store.upsertNode(
        makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, summary: "refactored the parser" }),
      );
      store.indexNodeFiles("claude:n1", [{ path: "adapter-claude/src/parser.ts", status: "M" }]);

      expect(
        store.search("project-1", { q: "refactored", file: "nope.ts" }),
      ).toEqual([]);
    });
  });

  describe("cross-project isolation", () => {
    it("never returns hits from another project (q)", () => {
      store.upsertNode(
        makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, projectId: "project-1", summary: "shared keyword zephyr" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:n2", meta: { nativeUuid: "n2" }, projectId: "project-2", summary: "shared keyword zephyr" }),
      );

      const hits = store.search("project-1", { q: "zephyr" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("never returns hits from another project (file)", () => {
      store.upsertNode(
        makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, projectId: "project-1" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:n2", meta: { nativeUuid: "n2" }, projectId: "project-2" }),
      );
      store.indexNodeFiles("claude:n1", [{ path: "shared/name.ts", status: "M" }]);
      store.indexNodeFiles("claude:n2", [{ path: "shared/name.ts", status: "M" }]);

      const hits = store.search("project-1", { file: "shared/name.ts" });
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });

    it("never returns hits from another project (no q, no file — kind/listing mode)", () => {
      store.upsertNode(
        makeNode({ id: "claude:n1", meta: { nativeUuid: "n1" }, projectId: "project-1" }),
      );
      store.upsertNode(
        makeNode({ id: "claude:n2", meta: { nativeUuid: "n2" }, projectId: "project-2" }),
      );

      const hits = store.search("project-1", {});
      expect(hits.map((h) => h.node.id)).toEqual(["claude:n1"]);
    });
  });

  describe("limit", () => {
    it("respects the limit option", () => {
      for (let i = 0; i < 5; i++) {
        store.upsertNode(
          makeNode({
            id: `claude:n${i}`,
            meta: { nativeUuid: `n${i}` },
            summary: "matches the query token wombat",
            timestamp: `2026-01-01T00:00:0${i}.000Z`,
          }),
        );
      }
      const hits = store.search("project-1", { q: "wombat", limit: 2 });
      expect(hits).toHaveLength(2);
    });

    it("defaults to a bounded limit when omitted", () => {
      for (let i = 0; i < 5; i++) {
        store.upsertNode(
          makeNode({ id: `claude:n${i}`, meta: { nativeUuid: `n${i}` }, timestamp: `2026-01-01T00:00:0${i}.000Z` }),
        );
      }
      const hits = store.search("project-1", {});
      expect(hits).toHaveLength(5);
    });
  });
});
