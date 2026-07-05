import { describe, it, expect } from "vitest";
import { editClaimCheck } from "../../src/flags/editClaim.js";
import type { ChronoNode, FileChange } from "../../src/types.js";
import type { CheckContext, FetchJson } from "../../src/interfaces.js";

function makeNode(overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id: "claude:node-1",
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: new Date().toISOString(),
    snapshotRef: "deadbeef",
    label: null,
    summary: "",
    content: "",
    meta: { nativeUuid: "node-1" },
    ...overrides,
  };
}

const failFetch: FetchJson = async () => {
  throw new Error("network should not be called by editClaimCheck");
};

function makeCtx(overrides: Partial<CheckContext>): CheckContext {
  const node = overrides.node ?? makeNode();
  return {
    node,
    priorNodes: [node],
    diff: [],
    parentTree: "parent-tree",
    nodeTree: "node-tree",
    projectRoot: "/tmp/project",
    snapshotter: null,
    fetchJson: failFetch,
    ...overrides,
  };
}

describe("editClaimCheck.appliesTo", () => {
  it("applies only to assistant nodes with string text content", () => {
    expect(editClaimCheck.appliesTo(makeNode({ kind: "assistant", content: "hi" }))).toBe(true);
    expect(editClaimCheck.appliesTo(makeNode({ kind: "tool_use", content: "hi" }))).toBe(false);
    expect(editClaimCheck.appliesTo(makeNode({ kind: "assistant", content: { foo: 1 } }))).toBe(false);
    expect(
      editClaimCheck.appliesTo(makeNode({ kind: "assistant", content: { type: "text", text: "hi" } })),
    ).toBe(true);
  });
});

describe("editClaimCheck.run — true positives", () => {
  it("flags high when an EDIT claim's path is not in the diff at all", async () => {
    const node = makeNode({ content: "I updated `auth.py` to handle refresh tokens." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("edit_claim_mismatch");
    expect(flags[0].tier).toBe("verified");
    expect(flags[0].source).toBe("deterministic");
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence).toContain("auth.py");
    expect(flags[0].evidence.toLowerCase()).toContain("diff");
  });

  it("flags high when a CREATE claim's path was not added in the diff", async () => {
    const node = makeNode({ content: "I created `src/newfile.ts` for the new helper." });
    const ctx = makeCtx({ node, diff: [] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("edit_claim_mismatch");
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence).toContain("src/newfile.ts");
  });

  it("flags medium when a CREATE claim's path exists in diff but only as Modified", async () => {
    const node = makeNode({ content: "I created `src/existing.ts` with the new export." });
    const ctx = makeCtx({ node, diff: [{ path: "src/existing.ts", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("medium");
    expect(flags[0].evidence).toContain("src/existing.ts");
  });

  it("flags high when a DELETE claim's path was not deleted in the diff", async () => {
    const node = makeNode({ content: "I deleted `old/legacy.py` since it was unused." });
    const ctx = makeCtx({ node, diff: [{ path: "old/legacy.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].kind).toBe("edit_claim_mismatch");
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence).toContain("old/legacy.py");
  });

  it("flags one high flag per claimed path when diff is empty and there are edit claims", async () => {
    const node = makeNode({ content: "I updated `auth.py` and also modified `db.py` for consistency." });
    const ctx = makeCtx({ node, diff: [] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(2);
    for (const f of flags) {
      expect(f.confidence).toBe("high");
      expect(f.kind).toBe("edit_claim_mismatch");
    }
  });

  it("allows basename match when claim is a bare filename and exactly one diff path has that basename", async () => {
    const node = makeNode({ content: "I edited `auth.py` to add refresh logic." });
    const ctxMatch = makeCtx({ node, diff: [{ path: "src/server/auth.py", status: "M" }] });
    const flagsMatch = await editClaimCheck.run(ctxMatch);
    expect(flagsMatch).toHaveLength(0);
  });
});

describe("editClaimCheck.run — true negatives (precision)", () => {
  it("does not flag when the claimed EDIT path is present in the diff", async () => {
    const node = makeNode({ content: "I updated `auth.py` to handle refresh tokens." });
    const ctx = makeCtx({ node, diff: [{ path: "auth.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when the claimed CREATE path is present in the diff as Added", async () => {
    const node = makeNode({ content: "I created `src/newfile.ts` for the new helper." });
    const ctx = makeCtx({ node, diff: [{ path: "src/newfile.ts", status: "A" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when the claimed DELETE path is present in the diff as Deleted", async () => {
    const node = makeNode({ content: "I deleted `old/legacy.py` since it was unused." });
    const ctx = makeCtx({ node, diff: [{ path: "old/legacy.py", status: "D" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when there is no edit-claim language at all", async () => {
    const node = makeNode({ content: "Here's a summary of what `auth.py` currently does." });
    const ctx = makeCtx({ node, diff: [] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag backticked URLs, commands with spaces, or globs even near claim verbs", async () => {
    const node = makeNode({
      content:
        "I updated `https://example.com/file.py` and changed `rm -rf tmp` and modified `src/**/*.ts` files.",
    });
    const ctx = makeCtx({ node, diff: [] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("produces NO flags when nodeTree is null (no ground truth)", async () => {
    const node = makeNode({ content: "I updated `auth.py` to handle refresh tokens." });
    const ctx = makeCtx({ node, diff: [], nodeTree: null });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("produces NO flags when parentTree is null (no ground truth)", async () => {
    const node = makeNode({ content: "I updated `auth.py` to handle refresh tokens." });
    const ctx = makeCtx({ node, diff: [], parentTree: null });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not flag when content has no extractable text (non-string, non-text-block)", async () => {
    const node = makeNode({ kind: "tool_use", content: { type: "tool_use", name: "Bash", input: {} } });
    const ctx = makeCtx({ node, diff: [] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });
});
