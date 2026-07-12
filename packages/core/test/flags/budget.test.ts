import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { applyBudgets, getSessionHealth } from "../../src/flags/budget.js";
import type { DigestFlag } from "../../src/flags/budget.js";
import { GraphStore } from "../../src/store/index.js";
import type { ChronoNode, Flag } from "../../src/types.js";

function makeFlag(overrides: Partial<Flag> = {}): Flag {
  return {
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence: "high",
    evidence: "claimed edit to `x.py`; snapshot diff shows no change to that file",
    source: "deterministic",
    ...overrides,
  };
}

/** 15 distinct edit_claim_mismatch claims — one per file — so dedup leaves
 * all 15 intact (they are NOT byte-identical evidence, just the same
 * "flavor" of false-edit claim repeated many times in one turn, the
 * flag-storm scenario budgets exist for). */
function distinctEditClaims(n: number, kind: Flag["kind"] = "edit_claim_mismatch", tier: Flag["tier"] = "verified", source: Flag["source"] = "deterministic"): Flag[] {
  return Array.from({ length: n }, (_, i) =>
    makeFlag({
      kind,
      tier,
      source,
      confidence: i === 0 ? "low" : "high", // exercise "confidence of the highest suppressed"
      evidence: `claimed edit to \`file${i}.py\`; snapshot diff shows no change to that file`,
    }),
  );
}

describe("applyBudgets", () => {
  it("flag storm: 15 distinct edit_claim_mismatch claims collapse to the flagship budget (10) plus one digest", () => {
    const flags = distinctEditClaims(15);
    const result = applyBudgets(flags);

    expect(result.kept.length).toBeLessThanOrEqual(10);
    expect(result.kept).toHaveLength(10);
    expect(result.digests).toHaveLength(1);

    const [digest] = result.digests;
    expect(digest.kind).toBe("edit_claim_mismatch");
    expect(digest.tier).toBe("verified");
    expect(digest.source).toBe("deterministic");
    expect(digest.suppressedCount).toBe(5);
    expect(result.suppressed).toBe(5);
    // evidence = "<first sample evidence> …and similar claims suppressed" —
    // deliberately COUNT-FREE so a rerun that suppresses a different number
    // of claims produces the same evidence string (the store's
    // (node_id, kind, evidence) upsert then updates suppressed_count in
    // place instead of inserting a near-duplicate row). The count lives
    // ONLY in suppressedCount.
    expect(digest.evidence).toContain("…and similar claims suppressed");
    expect(digest.evidence).not.toMatch(/and \d+/);
    expect(digest.evidence.startsWith("claimed edit to `file10.py`")).toBe(true);
  });

  it("collapses byte-identical duplicate claims (same kind+tier+claim tokens) down to one before budgeting", () => {
    const evidence = "claimed edit to `auth.py`; snapshot diff shows no change to that file";
    const flags = [
      makeFlag({ evidence }),
      makeFlag({ evidence }),
      makeFlag({ evidence }),
    ];
    const result = applyBudgets(flags);
    expect(result.kept).toHaveLength(1);
    expect(result.digests).toHaveLength(0);
    expect(result.suppressed).toBe(0);
  });

  it("dedups MORE-than-budget byte-identical duplicates BEFORE budgeting: 15 dupes, budget 3 -> 1 kept, 0 digests", () => {
    // If budgeting ran first, 15 identical package_hallucination flags
    // (budget 3) would keep 3 and emit a digest for the other 12. Dedup
    // running FIRST collapses all 15 to one flag, which is under budget:
    // exactly 1 kept, no digest, nothing suppressed.
    const evidence =
      "claimed/used import of package `bogus-pkg`; PyPI returned 404 (not found) for that package name";
    const flags = Array.from({ length: 15 }, () =>
      makeFlag({ kind: "package_hallucination", evidence }),
    );
    const result = applyBudgets(flags);
    expect(result.kept).toHaveLength(1);
    expect(result.digests).toHaveLength(0);
    expect(result.suppressed).toBe(0);
  });

  it("leaves distinct claims under budget completely untouched, with zero digests", () => {
    const flags = distinctEditClaims(3, "package_hallucination"); // budget 3, exactly at the line
    const result = applyBudgets(flags);
    expect(result.kept).toHaveLength(3);
    expect(result.kept).toEqual(flags);
    expect(result.digests).toHaveLength(0);
    expect(result.suppressed).toBe(0);
  });

  it("never mixes kinds into one digest: two overflowing kinds produce two separate digests", () => {
    const editFlags = distinctEditClaims(15, "edit_claim_mismatch"); // budget 10 -> 5 suppressed
    const symbolFlags = distinctEditClaims(5, "symbol_not_found"); // budget 3 -> 2 suppressed
    const result = applyBudgets([...editFlags, ...symbolFlags]);

    expect(result.digests).toHaveLength(2);
    const byKind = new Map(result.digests.map((d) => [d.kind, d]));
    expect(byKind.get("edit_claim_mismatch")?.suppressedCount).toBe(5);
    expect(byKind.get("symbol_not_found")?.suppressedCount).toBe(2);
    // each digest's evidence sample must come from ITS OWN kind's claims,
    // never the other kind's ("claimed edit to ..." vs "claimed edit to
    // ...` in symbol_not_found's reused evidence template) — the grouping
    // key is kind-scoped, so a digest can never straddle two kinds.
    expect(byKind.get("edit_claim_mismatch")?.kind).toBe("edit_claim_mismatch");
    expect(byKind.get("symbol_not_found")?.kind).toBe("symbol_not_found");
    expect(result.digests.map((d) => d.kind).sort()).toEqual(
      ["edit_claim_mismatch", "symbol_not_found"].sort(),
    );
  });

  it("keeps verified and advisory budgets independent: both overflowing produces 2 digests, tiers never blur", () => {
    const verifiedFlags = distinctEditClaims(6, "test_claim_unverified", "verified", "deterministic"); // budget 3 -> 3 suppressed
    const advisoryFlags = distinctEditClaims(5, "possible_hallucination", "advisory", "llm_critic"); // budget 2 -> 3 suppressed
    const result = applyBudgets([...verifiedFlags, ...advisoryFlags]);

    expect(result.digests).toHaveLength(2);
    const verifiedDigest = result.digests.find((d) => d.tier === "verified")!;
    const advisoryDigest = result.digests.find((d) => d.tier === "advisory")!;
    expect(verifiedDigest).toBeDefined();
    expect(advisoryDigest).toBeDefined();
    expect(verifiedDigest.kind).toBe("test_claim_unverified");
    expect(verifiedDigest.source).toBe("deterministic");
    expect(verifiedDigest.suppressedCount).toBe(3);
    expect(advisoryDigest.kind).toBe("possible_hallucination");
    expect(advisoryDigest.source).toBe("llm_critic");
    expect(advisoryDigest.suppressedCount).toBe(3);
  });

  it("gives the flagship kind (edit_claim_mismatch) a larger default budget than every other kind", () => {
    const editFlags = distinctEditClaims(15, "edit_claim_mismatch");
    const fileRefFlags = distinctEditClaims(15, "file_ref_missing");
    const result = applyBudgets([...editFlags, ...fileRefFlags]);

    const editKept = result.kept.filter((f) => f.kind === "edit_claim_mismatch").length;
    const fileRefKept = result.kept.filter((f) => f.kind === "file_ref_missing").length;
    expect(editKept).toBe(10);
    expect(fileRefKept).toBe(3);
    expect(editKept).toBeGreaterThan(fileRefKept);
  });

  it("respects a caller-supplied budget override", () => {
    const flags = distinctEditClaims(5, "package_hallucination");
    const result = applyBudgets(flags, { budgets: { package_hallucination: 2 } });
    expect(result.kept).toHaveLength(2);
    expect(result.digests).toHaveLength(1);
    expect(result.digests[0].suppressedCount).toBe(3);
  });

  it("digest confidence is the highest confidence among the SUPPRESSED flags, not the kept ones", () => {
    // budget 3: first 3 kept (mixed confidence), remaining 2 suppressed —
    // give the suppressed ones "medium" and "low" so we can tell the digest
    // picked from the suppressed set, not from `flags` as a whole (which
    // also contains "high" among the kept).
    const flags: Flag[] = [
      makeFlag({ kind: "symbol_not_found", confidence: "high", evidence: "claimed symbol `a` in `f0.ts`" }),
      makeFlag({ kind: "symbol_not_found", confidence: "high", evidence: "claimed symbol `a` in `f1.ts`" }),
      makeFlag({ kind: "symbol_not_found", confidence: "high", evidence: "claimed symbol `a` in `f2.ts`" }),
      makeFlag({ kind: "symbol_not_found", confidence: "low", evidence: "claimed symbol `a` in `f3.ts`" }),
      makeFlag({ kind: "symbol_not_found", confidence: "medium", evidence: "claimed symbol `a` in `f4.ts`" }),
    ];
    const result = applyBudgets(flags);
    expect(result.kept).toHaveLength(3);
    expect(result.digests).toHaveLength(1);
    expect(result.digests[0].confidence).toBe("medium");
  });

  it("returns an empty result for an empty input", () => {
    const result = applyBudgets([]);
    expect(result.kept).toEqual([]);
    expect(result.digests).toEqual([]);
    expect(result.suppressed).toBe(0);
  });
});

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

describe("GraphStore.addFlag / rowToFlag: suppressedCount round-trip", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("persists and reads back a digest flag's suppressedCount", () => {
    const node = makeNode();
    store.upsertNode(node);

    const digests = applyBudgets(distinctEditClaims(15)).digests;
    expect(digests).toHaveLength(1);
    const digest: DigestFlag = digests[0];

    const stored = store.addFlag(node.id, digest);
    expect(stored.suppressedCount).toBe(5);

    const [reloaded] = store.getFlags(node.id);
    expect(reloaded.suppressedCount).toBe(5);
  });

  it("omits suppressedCount (undefined) for an ordinary, non-digest flag", () => {
    const node = makeNode({ id: "claude:uuid-2", meta: { nativeUuid: "uuid-2" } });
    store.upsertNode(node);

    const stored = store.addFlag(node.id, makeFlag());
    expect(stored.suppressedCount).toBeUndefined();

    const [reloaded] = store.getFlags(node.id);
    expect(reloaded.suppressedCount).toBeUndefined();
  });

  it("rerun with a different suppressed count updates the existing digest row in place (still ONE row)", () => {
    const node = makeNode({ id: "claude:uuid-3", meta: { nativeUuid: "uuid-3" } });
    store.upsertNode(node);

    // First run: 15 claims -> digest suppressing 5. Second run: 14 claims ->
    // same sample (file10), digest suppressing 4. Evidence is count-free so
    // both digests carry the SAME evidence string.
    const [first] = applyBudgets(distinctEditClaims(15)).digests;
    const [second] = applyBudgets(distinctEditClaims(14)).digests;
    expect(first.evidence).toBe(second.evidence);
    expect(first.suppressedCount).toBe(5);
    expect(second.suppressedCount).toBe(4);

    store.addFlag(node.id, first);
    store.addFlag(node.id, second);

    const flags = store.getFlags(node.id);
    expect(flags).toHaveLength(1);
    expect(flags[0].suppressedCount).toBe(4);
  });

  it("digest re-insert raises confidence when the incoming digest's is higher, never lowers it", () => {
    const node = makeNode({ id: "claude:uuid-4", meta: { nativeUuid: "uuid-4" } });
    store.upsertNode(node);

    const digest = (confidence: Flag["confidence"], suppressedCount: number): DigestFlag => ({
      ...makeFlag({
        kind: "edit_claim_mismatch",
        confidence,
        evidence:
          "claimed edit to `sample.py`; snapshot diff shows no change to that file …and similar claims suppressed",
      }),
      suppressedCount,
    });

    store.addFlag(node.id, digest("low", 5));
    let [row] = store.getFlags(node.id);
    expect(row.confidence).toBe("low");

    // higher incoming confidence -> raised
    store.addFlag(node.id, digest("high", 6));
    [row] = store.getFlags(node.id);
    expect(store.getFlags(node.id)).toHaveLength(1);
    expect(row.confidence).toBe("high");
    expect(row.suppressedCount).toBe(6);

    // lower incoming confidence -> count still updates, confidence kept
    store.addFlag(node.id, digest("medium", 2));
    [row] = store.getFlags(node.id);
    expect(store.getFlags(node.id)).toHaveLength(1);
    expect(row.confidence).toBe("high");
    expect(row.suppressedCount).toBe(2);
  });

  it("digest update does not clobber dismissed/auto-resolved state on the existing row", () => {
    const node = makeNode({ id: "claude:uuid-5", meta: { nativeUuid: "uuid-5" } });
    store.upsertNode(node);

    const [first] = applyBudgets(distinctEditClaims(15)).digests;
    const stored = store.addFlag(node.id, first);
    store.dismissFlag(stored.id);

    const [second] = applyBudgets(distinctEditClaims(14)).digests;
    store.addFlag(node.id, second);

    const flags = store.getFlags(node.id);
    expect(flags).toHaveLength(1);
    expect(flags[0].dismissed).toBe(true); // user's dismissal survives reruns
    expect(flags[0].suppressedCount).toBe(4);
  });

  it("non-digest duplicate insert stays a pure no-op (DO NOTHING; never updates the existing row)", () => {
    const node = makeNode({ id: "claude:uuid-6", meta: { nativeUuid: "uuid-6" } });
    store.upsertNode(node);

    const evidence = "claimed edit to `plain.py`; snapshot diff shows no change to that file";
    store.addFlag(node.id, makeFlag({ evidence, confidence: "low" }));
    // duplicate (same node_id, kind, evidence) with higher confidence — the
    // ordinary-flag path must NOT adopt digest update semantics.
    store.addFlag(node.id, makeFlag({ evidence, confidence: "high" }));

    const flags = store.getFlags(node.id);
    expect(flags).toHaveLength(1);
    expect(flags[0].confidence).toBe("low");
    expect(flags[0].suppressedCount).toBeUndefined();
  });
});

describe("getSessionHealth", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("reports exact pure counts across turns, dismissed, auto-resolved, and digest rows", () => {
    const sessionId = "sess-health";
    const projectId = "proj-health";

    // 3 turns (prompt nodes) + a couple of non-prompt nodes in between.
    const p1 = makeNode({
      id: "claude:p1",
      meta: { nativeUuid: "p1" },
      kind: "prompt",
      sessionId,
      projectId,
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    const a1 = makeNode({
      id: "claude:a1",
      meta: { nativeUuid: "a1" },
      kind: "assistant",
      sessionId,
      projectId,
      timestamp: "2026-01-01T00:00:02.000Z",
    });
    const p2 = makeNode({
      id: "claude:p2",
      meta: { nativeUuid: "p2" },
      kind: "prompt",
      sessionId,
      projectId,
      timestamp: "2026-01-01T00:00:03.000Z",
    });
    const p3 = makeNode({
      id: "claude:p3",
      meta: { nativeUuid: "p3" },
      kind: "prompt",
      sessionId,
      projectId,
      timestamp: "2026-01-01T00:00:04.000Z",
    });
    // node from a DIFFERENT session — must not leak into these counts.
    const otherSession = makeNode({
      id: "claude:other",
      meta: { nativeUuid: "other" },
      kind: "prompt",
      sessionId: "some-other-session",
      projectId,
      timestamp: "2026-01-01T00:00:05.000Z",
    });
    for (const n of [p1, a1, p2, p3, otherSession]) store.upsertNode(n);

    // p1: one active verified flag, one dismissed advisory flag.
    store.addFlag(p1.id, makeFlag({ evidence: "claimed edit to `p1a.py`; no change" }));
    store.addFlag(p1.id, {
      kind: "possible_hallucination",
      tier: "advisory",
      confidence: "low",
      evidence: "maybe unfounded claim in p1",
      source: "llm_critic",
    });
    const p1Flags = store.getFlags(p1.id);
    const dismissedAdvisory = p1Flags.find((f) => f.kind === "possible_hallucination")!;
    store.dismissFlag(dismissedAdvisory.id);

    // a1: one auto-resolved verified flag (still counts under this node's turn).
    const resolved = store.addFlag(a1.id, makeFlag({ evidence: "claimed edit to `a1.py`; no change" }));
    store.resolveFlag(resolved.id);

    // p2: an active advisory flag + a digest (suppressedCount = 11) verified flag.
    store.addFlag(p2.id, {
      kind: "unstated_assumption",
      tier: "advisory",
      confidence: "medium",
      evidence: "assumed X without stating it",
      source: "llm_critic",
    });
    const digestFlags = applyBudgets(distinctEditClaims(14, "file_ref_missing")).digests; // budget 3 -> suppressed 11
    expect(digestFlags).toHaveLength(1);
    store.addFlag(p2.id, digestFlags[0]);

    // p3: no flags at all.

    const health = getSessionHealth(store, sessionId);

    expect(health.sessionId).toBe(sessionId);
    expect(health.turns).toBe(3); // p1, p2, p3 — not a1, not the other session's prompt
    // Active verified: p1's active edit_claim_mismatch + p2's digest (a digest
    // that hasn't been dismissed/auto-resolved is still an active verified row).
    expect(health.verifiedActive).toBe(2);
    expect(health.verifiedResolved).toBe(1); // a1's resolved flag
    expect(health.advisoryActive).toBe(1); // p2's unstated_assumption
    expect(health.dismissed).toBe(1); // p1's dismissed advisory flag
    expect(health.suppressed).toBe(11); // digest's suppressedCount summed in
  });

  it("sums an advisory-tier digest's suppressedCount into suppressed and counts the digest row as advisoryActive", () => {
    const sessionId = "sess-advisory-digest";
    const node = makeNode({
      id: "claude:adv1",
      meta: { nativeUuid: "adv1" },
      kind: "prompt",
      sessionId,
      projectId: "proj-advisory",
    });
    store.upsertNode(node);

    // 9 distinct advisory critic claims, budget 2 -> digest suppressing 7.
    const advisory = distinctEditClaims(9, "possible_hallucination", "advisory", "llm_critic");
    const { digests } = applyBudgets(advisory);
    expect(digests).toHaveLength(1);
    expect(digests[0].tier).toBe("advisory");
    expect(digests[0].suppressedCount).toBe(7);
    store.addFlag(node.id, digests[0]);

    const health = getSessionHealth(store, sessionId);
    expect(health.suppressed).toBe(7); // advisory digest's count summed in
    expect(health.advisoryActive).toBe(1); // the digest row itself is an active advisory
    expect(health.verifiedActive).toBe(0);
    expect(health.verifiedResolved).toBe(0);
    expect(health.dismissed).toBe(0);
  });

  it("returns all-zero counts for a session with no nodes", () => {
    const health = getSessionHealth(store, "no-such-session");
    expect(health).toEqual({
      sessionId: "no-such-session",
      turns: 0,
      verifiedActive: 0,
      verifiedResolved: 0,
      advisoryActive: 0,
      dismissed: 0,
      suppressed: 0,
    });
  });
});
