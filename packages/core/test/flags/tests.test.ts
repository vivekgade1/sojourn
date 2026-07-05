import { describe, it, expect } from "vitest";
import { testsCheck } from "../../src/flags/tests.js";
import type { ChronoNode } from "../../src/types.js";
import type { CheckContext, FetchJson } from "../../src/interfaces.js";

let counter = 0;
function makeNode(overrides: Partial<ChronoNode> = {}): ChronoNode {
  counter += 1;
  return {
    id: `claude:node-${counter}`,
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: new Date().toISOString(),
    snapshotRef: "deadbeef",
    label: null,
    summary: "",
    content: "done",
    meta: { nativeUuid: `node-${counter}` },
    ...overrides,
  };
}

function makeCtx(node: ChronoNode, priorNodes: ChronoNode[]): CheckContext {
  return {
    node,
    priorNodes,
    diff: [],
    parentTree: "parent-tree",
    nodeTree: "node-tree",
    projectRoot: "/tmp/project",
    snapshotter: null,
    fetchJson: (async () => ({ status: 200, body: {} })) as FetchJson,
  };
}

describe("testsCheck.appliesTo", () => {
  it("applies only to assistant nodes with string text content", () => {
    expect(testsCheck.appliesTo(makeNode({ kind: "assistant", content: "all tests pass" }))).toBe(true);
    expect(testsCheck.appliesTo(makeNode({ kind: "tool_result", content: "all tests pass" }))).toBe(false);
    expect(testsCheck.appliesTo(makeNode({ kind: "assistant", content: 5 }))).toBe(false);
  });
});

describe("testsCheck.run — true positives", () => {
  it("flags HIGH when a passing-tests claim follows an observed FAILING test run", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const toolUse = makeNode({ kind: "tool_use", content: "npx vitest run" });
    const toolResult = makeNode({
      kind: "tool_result",
      content: "Test Files  1 failed (1)\nTests  2 failed | 3 passed (5)",
    });
    const assistant = makeNode({ kind: "assistant", content: "Great, all tests pass now!" });
    const priorNodes = [prompt, toolUse, toolResult, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("test_claim_unverified");
    expect(flags[0].tier).toBe("verified");
    expect(flags[0].source).toBe("deterministic");
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence.toLowerCase()).toContain("fail");
  });

  it("flags MEDIUM when a passing-tests claim has no observed test run since the last prompt", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const assistant = makeNode({ kind: "assistant", content: "All tests pass now." });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("test_claim_unverified");
    expect(flags[0].confidence).toBe("medium");
    expect(flags[0].evidence.toLowerCase()).toContain("no test run");
  });

  it("flags MEDIUM for a claimed build success with no observed build/test run", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the build" });
    const assistant = makeNode({ kind: "assistant", content: "The build succeeds now." });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
  });
});

describe("testsCheck.run — true negatives (precision)", () => {
  it("does not flag when a passing-tests claim follows an observed PASSING test run", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const toolUse = makeNode({ kind: "tool_use", content: "npx vitest run" });
    const toolResult = makeNode({
      kind: "tool_result",
      content: "Test Files  3 passed (3)\nTests  12 passed (12)",
    });
    const assistant = makeNode({ kind: "assistant", content: "All tests pass now." });
    const priorNodes = [prompt, toolUse, toolResult, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when the text has no tests/build-passing claim at all", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const assistant = makeNode({ kind: "assistant", content: "I updated the helper function." });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when a passing test run's output mentions a test name containing 'error' (weak signal, not a strong failure marker)", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const toolUse = makeNode({ kind: "tool_use", content: "npx vitest run" });
    const toolResult = makeNode({
      kind: "tool_result",
      content:
        "Test Files  3 passed (3)\n" +
        "Tests  12 passed (12)\n" +
        "  ✓ handles error case gracefully\n" +
        "  ✓ logs a warning error message without throwing\n",
    });
    const assistant = makeNode({ kind: "assistant", content: "Great, all tests pass now!" });
    const priorNodes = [prompt, toolUse, toolResult, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when the test run output contains the literal string '0 failed'", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const toolUse = makeNode({ kind: "tool_use", content: "npx vitest run" });
    const toolResult = makeNode({
      kind: "tool_result",
      content: "Test Files  3 passed (3)\nTests  12 passed, 0 failed (12)",
    });
    const assistant = makeNode({ kind: "assistant", content: "All tests pass now." });
    const priorNodes = [prompt, toolUse, toolResult, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when a Jest PASSING summary line has 'fail' inside '0 failed' preceding 'passed'", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const toolUse = makeNode({ kind: "tool_use", content: "npx jest" });
    const toolResult = makeNode({
      kind: "tool_result",
      content: "Tests:       0 failed, 12 passed, 12 total",
    });
    const assistant = makeNode({ kind: "assistant", content: "All tests pass now." });
    const priorNodes = [prompt, toolUse, toolResult, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("flags HIGH when a Jest summary line shows a genuine nonzero failure count ('3 failed, 9 passed, 12 total')", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const toolUse = makeNode({ kind: "tool_use", content: "npx jest" });
    const toolResult = makeNode({
      kind: "tool_result",
      content: "Tests:       3 failed, 9 passed, 12 total",
    });
    const assistant = makeNode({ kind: "assistant", content: "All tests pass now." });
    const priorNodes = [prompt, toolUse, toolResult, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("high");
  });

  it("does not look past the previous prompt node for a test run (stale run from an earlier turn doesn't count)", async () => {
    const oldToolUse = makeNode({ kind: "tool_use", content: "npx vitest run" });
    const oldToolResult = makeNode({
      kind: "tool_result",
      content: "Test Files  3 passed (3)\nTests  12 passed (12)",
    });
    const prompt = makeNode({ kind: "prompt", content: "now also update the docs" });
    const assistant = makeNode({ kind: "assistant", content: "All tests pass now." });
    const priorNodes = [oldToolUse, oldToolResult, prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    // No run observed since the last prompt -> medium flag, not silence,
    // but importantly it must NOT be silently treated as a verified good run.
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
  });

  it("does not flag a future/conditional claim ('once tests pass we can merge')", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const assistant = makeNode({
      kind: "assistant",
      content: "Once tests pass we can merge this branch.",
    });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag a quoted/reported claim ('You asked me to make sure all tests pass — here's my plan')", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const assistant = makeNode({
      kind: "assistant",
      content: "You asked me to make sure all tests pass — here's my plan.",
    });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("flags a genuine claim ('After the fix, all tests pass.') even though 'After' precedes it in the sentence", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const assistant = makeNode({
      kind: "assistant",
      content: "After the fix, all tests pass.",
    });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
  });

  it("flags a genuine claim ('I ran the test suite before lunch and all tests pass.') even though 'before' appears earlier in the sentence", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const assistant = makeNode({
      kind: "assistant",
      content: "I ran the test suite before lunch and all tests pass.",
    });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
  });

  it("flags a genuine claim ('I want to note that all tests pass.') even though 'want' appears earlier in the sentence", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const assistant = makeNode({
      kind: "assistant",
      content: "I want to note that all tests pass.",
    });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
  });

  it("still flags a genuine unhedged claim with no observed run (keeps true positives green)", async () => {
    const prompt = makeNode({ kind: "prompt", content: "please fix the bug" });
    const assistant = makeNode({ kind: "assistant", content: "All tests pass now." });
    const priorNodes = [prompt, assistant];
    const ctx = makeCtx(assistant, priorNodes);
    const flags = await testsCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
  });
});
