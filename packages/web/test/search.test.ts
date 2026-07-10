import { describe, expect, it } from "vitest";
import { searchNodes } from "../src/search";
import type { ChronoNode } from "../src/types";

function makeNode(id: string, overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id,
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: "2026-01-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: "",
    content: null,
    meta: { nativeUuid: id },
    ...overrides,
  };
}

describe("searchNodes", () => {
  const nodes: ChronoNode[] = [
    makeNode("claude:1", { summary: "I updated the auth middleware" }),
    makeNode("claude:2", { kind: "tool_use", summary: "Bash: npm test", content: { name: "Bash" } }),
    makeNode("claude:3", { kind: "tool_result", summary: "12 passed" }),
    makeNode("claude:4", { label: "chose SQLite over Postgres", kind: "decision", summary: "db choice" }),
  ];

  it("matches summaries case-insensitively", () => {
    expect(searchNodes(nodes, "AUTH")).toEqual(["claude:1"]);
  });

  it("matches labels, kinds (with underscores spaced), tool names, and ids", () => {
    expect(searchNodes(nodes, "sqlite")).toEqual(["claude:4"]);
    expect(searchNodes(nodes, "tool result")).toEqual(["claude:3"]);
    expect(searchNodes(nodes, "bash")).toContain("claude:2");
    expect(searchNodes(nodes, "claude:2")).toEqual(["claude:2"]);
  });

  it("returns no matches for an empty or whitespace query (search off)", () => {
    expect(searchNodes(nodes, "")).toEqual([]);
    expect(searchNodes(nodes, "   ")).toEqual([]);
  });

  it("returns empty for a query nothing matches", () => {
    expect(searchNodes(nodes, "kubernetes")).toEqual([]);
  });
});
