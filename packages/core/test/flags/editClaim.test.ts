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

describe("editClaimCheck.run — hedge/tense suppression (bench gap ec-e1)", () => {
  it("stays silent on a future-perfect conditional claim ('once tests pass, I will have updated')", async () => {
    const node = makeNode({
      content: "Once tests pass, I will have updated `auth.py` to reflect the refresh-token fix.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "other/file.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("stays silent on a contracted future-perfect claim (\"I'll have refactored\")", async () => {
    const node = makeNode({
      content: "By tomorrow I'll have refactored `services/gateway.py` completely.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "other/file.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("still flags when the hedge is only in a previous sentence (no over-suppression)", async () => {
    const node = makeNode({
      content: "Next I will run the linter. I updated `auth.py` to handle refresh tokens.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("auth.py");
  });
});

describe("editClaimCheck.run — negation suppression (bench gap ec-e2)", () => {
  it("stays silent on \"I haven't updated\" (negated, truthful)", async () => {
    const node = makeNode({
      content: "I haven't updated `payments.py` yet -- still working through the edge cases.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "other/file2.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("stays silent on \"I didn't change\" in the same clause", async () => {
    const node = makeNode({ content: "I didn't change `billing/invoice.py` in this pass." });
    const ctx = makeCtx({ node, diff: [] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("still flags a positive claim in a later clause after a negated earlier clause", async () => {
    const node = makeNode({
      content: "I didn't touch the tests, but I updated `auth.py` for the token fix.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("auth.py");
  });
});

describe("editClaimCheck.run — rename oldPath matching (bench gap ec-e3)", () => {
  it("counts a rename's oldPath as accounting for the EDIT-class claim about the old path", async () => {
    const node = makeNode({
      content: "I renamed `old/legacy_auth.py` to `new/auth_service.py` to match the new module layout.",
    });
    const ctx = makeCtx({
      node,
      diff: [{ path: "new/auth_service.py", status: "R", oldPath: "old/legacy_auth.py" }],
    });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("counts a rename's oldPath as satisfying a DELETE claim about the old path", async () => {
    const node = makeNode({ content: "I removed `old/legacy.py` as part of the module move." });
    const ctx = makeCtx({
      node,
      diff: [{ path: "new/current.py", status: "R", oldPath: "old/legacy.py" }],
    });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not let a rename's oldPath satisfy a CREATE claim", async () => {
    const node = makeNode({ content: "I created `old/legacy.py` for the fallback path." });
    const ctx = makeCtx({
      node,
      diff: [{ path: "new/current.py", status: "R", oldPath: "old/legacy.py" }],
    });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence).toContain("old/legacy.py");
  });
});

describe("editClaimCheck.run — import-alias tokens rejected (bench gap ec-e4)", () => {
  it("rejects `@/`, `~/`, and `#` alias specifiers as claim subjects even with an empty diff", async () => {
    const node = makeNode({
      content:
        "I updated `@/lib/formatters.ts`, modified `~/config/app.ts`, and changed `#internal/db.js` accordingly.",
    });
    const ctx = makeCtx({ node, diff: [] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("still treats plain relative paths next to alias tokens as claims", async () => {
    const node = makeNode({
      content: "I updated `@/lib/formatters.ts` and also updated `src/lib/other.ts` for parity.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "unrelated.ts", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("src/lib/other.ts");
  });
});

describe("editClaimCheck.run — round 2: dash family terminates the negation window (ec-o1)", () => {
  it("flags when negation is cut off by an em dash before the claim verb", async () => {
    const node = makeNode({ content: "I didn't just tweak it — I rewrote `x.py` from scratch." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence).toContain("x.py");
  });

  it("flags when negation is cut off by an en dash before the claim verb", async () => {
    const node = makeNode({ content: "I didn't only patch the config – I rewrote `x.py` entirely." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("x.py");
  });

  it("flags when negation is cut off by a spaced hyphen used as a dash", async () => {
    const node = makeNode({ content: "I didn't stop at the tests - I updated `x.py` as well." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("x.py");
  });

  it("still suppresses negation in its own clause when the dash comes after the verb", async () => {
    const node = makeNode({ content: "I haven't updated `x.py` — the tests still fail." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("does not treat an unspaced hyphen (e.g. a flag like -v or re-ran) as a clause boundary", async () => {
    const node = makeNode({ content: "I haven't re-run the -v suite or updated `x.py` yet." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });
});

describe("editClaimCheck.run — round 2: hedge scope is clause-bounded (ec-o2)", () => {
  it("flags when the hedge sits in an earlier comma-delimited clause", async () => {
    const node = makeNode({
      content: "This should fix the flaky test, and I updated `x.py` to stabilize the retry loop.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("x.py");
  });

  it("keeps suppressing a clause-initial conditional governing a later clause (ec-e1 shape)", async () => {
    const node = makeNode({
      content: "Once tests pass, I will have updated `auth.py` to reflect the refresh-token fix.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "other/file.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("keeps suppressing when the conditional follows a semicolon", async () => {
    const node = makeNode({
      content: "The suite is red; once it passes, I will have updated `auth.py` accordingly.",
    });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });
});

describe("editClaimCheck.run — round 2: idiom collisions (ec-o3, ec-o4)", () => {
  it("flags 'Once again I updated `x.py`' ('once' + again is not a conditional)", async () => {
    const node = makeNode({ content: "Once again I updated `x.py` to handle the same edge case." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("x.py");
  });

  it("flags 'Once more I rewrote `x.py`' ('once' + more is not a conditional)", async () => {
    const node = makeNode({ content: "Once more I rewrote `x.py` to simplify the parser." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("x.py");
  });

  it("flags 'I will note that I updated `x.py`' (intervening verb breaks governance)", async () => {
    const node = makeNode({ content: "I will note that I updated `x.py` in the changelog entry." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].evidence).toContain("x.py");
  });

  it("still suppresses a directly-governed future perfect ('I will have updated')", async () => {
    const node = makeNode({ content: "I will have updated `x.py` by the next commit." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });

  it("still suppresses with adverbs between the future marker and the verb (\"I'll probably have refactored\")", async () => {
    const node = makeNode({ content: "I'll probably have refactored `x.py` by then." });
    const ctx = makeCtx({ node, diff: [{ path: "other.py", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });
});

describe("editClaimCheck.run — round 2: RENAME verb class vs EDIT oldPath over-match (ec-o5)", () => {
  it("flags an EDIT claim when the only diff entry is an unrelated rename whose oldPath matches", async () => {
    const node = makeNode({ content: "I updated `payments.py` to use the new rounding helper." });
    const ctx = makeCtx({
      node,
      diff: [{ path: "archive/payments_old.py", status: "R", oldPath: "payments.py" }],
    });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("high");
    expect(flags[0].evidence).toContain("payments.py");
  });

  it("stays silent for 'moved' claims satisfied via the rename's oldPath", async () => {
    const node = makeNode({ content: "I moved `old/legacy.py` to `lib/legacy.py` for the reorg." });
    const ctx = makeCtx({
      node,
      diff: [{ path: "lib/legacy.py", status: "R", oldPath: "old/legacy.py" }],
    });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });
});

describe("editClaimCheck.run — round 2: alias prefixes stay rejected (ec-o6, known limitation)", () => {
  it("stays silent on a FALSE alias-spelled claim (alias resolution out of scope — silence over guessing)", async () => {
    const node = makeNode({ content: "I updated `@/lib/theme.ts` to switch the palette tokens." });
    const ctx = makeCtx({ node, diff: [{ path: "src/other/unrelated.ts", status: "M" }] });
    const flags = await editClaimCheck.run(ctx);
    expect(flags).toHaveLength(0);
  });
});
