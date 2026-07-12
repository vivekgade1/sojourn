import type { ChronoNode, Flag, FlagKind, SessionHealth } from "../types.js";
import type { GraphStore } from "../store/graphStore.js";
import { claimIdentityKey } from "./engine.js";

/**
 * A digest ("rollup") flag produced by `applyBudgets` when a kind/tier
 * group in a single turn exceeds its budget. Every field a plain `Flag`
 * has is present (kind/tier/confidence/evidence/source stay meaningful on
 * their own), plus `suppressedCount` - the number of additional
 * identical-*kind* claims this one digest stands in for. `suppressedCount`
 * is always > 0 here (contrast with `StoredFlag.suppressedCount`, which is
 * `undefined`/0 for ordinary, non-digest flags once persisted).
 */
export interface DigestFlag extends Flag {
  suppressedCount: number;
}

export interface BudgetOptions {
  /** Per-kind override of the default per-turn budget. */
  budgets?: Partial<Record<FlagKind, number>>;
}

export interface BudgetResult {
  /** Flags that survive dedup + budgeting, in original relative order. */
  kept: Flag[];
  /** One digest per (kind, tier, source) group that overflowed its budget. */
  digests: DigestFlag[];
  /** Total flags collapsed into `digests` (sum of every digest's suppressedCount). */
  suppressed: number;
}

/** edit_claim_mismatch is the flagship T1 check (precision-tuned above the
 * others per the V1 design principles) and keeps the largest per-turn
 * budget so a storm of OTHER kinds can never crowd it out of view. */
const FLAGSHIP_KIND: FlagKind = "edit_claim_mismatch";
const DEFAULT_FLAGSHIP_BUDGET = 10;
const DEFAULT_VERIFIED_BUDGET = 3;
const DEFAULT_ADVISORY_BUDGET = 2;

function defaultBudgetFor(kind: FlagKind, tier: Flag["tier"]): number {
  if (kind === FLAGSHIP_KIND) return DEFAULT_FLAGSHIP_BUDGET;
  return tier === "advisory" ? DEFAULT_ADVISORY_BUDGET : DEFAULT_VERIFIED_BUDGET;
}

// Field separator for the composite keys below. "|" cannot appear inside a
// FlagKind/FlagTier/FlagSource literal (all are fixed identifier-like
// strings), so joining with it keeps the key unambiguous at field
// boundaries even though claim-token subjects are arbitrary text.
const KEY_SEP = "|";

/**
 * Claim identity for dedup purposes: the engine's canonical
 * `claimIdentityKey` (packages/core/src/flags/engine.ts) — the ONE
 * definition of "same claim", shared with `autoResolveFlags` — with `tier`
 * folded in on top, since budgets must never blur verified/advisory.
 */
function claimKey(flag: Flag): string {
  return [flag.tier, claimIdentityKey(flag)].join(KEY_SEP);
}

/** Grouping key for budgets/digests: kind+tier+source. Never mixes kinds or
 * tiers into one digest; source is folded in defensively even though today
 * every kind maps to exactly one (tier, source) pair. */
function groupKey(flag: Flag): string {
  return [flag.kind, flag.tier, flag.source].join(KEY_SEP);
}

const CONFIDENCE_RANK: Record<Flag["confidence"], number> = { low: 0, medium: 1, high: 2 };

function higherConfidence(a: Flag["confidence"], b: Flag["confidence"]): Flag["confidence"] {
  return CONFIDENCE_RANK[b] > CONFIDENCE_RANK[a] ? b : a;
}

/**
 * Applies per-turn flag budgets to ONE turn's freshly produced flags,
 * before they're persisted.
 *
 * Two passes:
 *  1. Dedup identical claims - same kind+tier+claim-tokens - down to the
 *     first occurrence. This is NOT the same as the store's
 *     (node_id, kind, evidence) uniqueness (which is exact-string and
 *     per-node); this pass collapses conceptually-identical claims across
 *     the whole turn (which may span several nodes) before budgeting.
 *  2. Per (kind, tier, source) budget: the first `budget` deduped flags in
 *     that group are kept; everything past the budget in that group
 *     collapses into ONE digest flag carrying `suppressedCount`.
 *
 * `kept` preserves the original relative ordering of `flags` (post-dedup).
 * Digest/rollup flags never mix kinds or tiers - one digest per overflowing
 * group - and the flagship kind (`edit_claim_mismatch`) keeps the largest
 * default budget so it can never be crowded out by a storm of other kinds.
 */
export function applyBudgets(flags: Flag[], opts: BudgetOptions = {}): BudgetResult {
  const seenClaims = new Set<string>();
  const deduped: Flag[] = [];
  for (const flag of flags) {
    const key = claimKey(flag);
    if (seenClaims.has(key)) continue;
    seenClaims.add(key);
    deduped.push(flag);
  }

  const budgetOverrides = opts.budgets ?? {};
  const keptCountByGroup = new Map<string, number>();
  const overflowByGroup = new Map<string, Flag[]>();
  const groupMeta = new Map<string, Pick<Flag, "kind" | "tier" | "source">>();

  const kept: Flag[] = [];

  for (const flag of deduped) {
    const key = groupKey(flag);
    if (!groupMeta.has(key)) {
      groupMeta.set(key, { kind: flag.kind, tier: flag.tier, source: flag.source });
    }
    const budget = budgetOverrides[flag.kind] ?? defaultBudgetFor(flag.kind, flag.tier);
    const soFar = keptCountByGroup.get(key) ?? 0;
    if (soFar < budget) {
      keptCountByGroup.set(key, soFar + 1);
      kept.push(flag);
    } else {
      const list = overflowByGroup.get(key);
      if (list) {
        list.push(flag);
      } else {
        overflowByGroup.set(key, [flag]);
      }
    }
  }

  const digests: DigestFlag[] = [];
  let suppressed = 0;
  for (const [key, list] of overflowByGroup) {
    if (list.length === 0) continue;
    const meta = groupMeta.get(key)!;
    const sample = list[0];
    let confidence = list[0].confidence;
    for (const f of list) confidence = higherConfidence(confidence, f.confidence);
    digests.push({
      kind: meta.kind,
      tier: meta.tier,
      confidence,
      // COUNT-FREE by design: the suppressed count lives ONLY in
      // `suppressedCount` (the store's suppressed_count column, which
      // UI/consumers read). Embedding N here would change the evidence
      // string across re-runs that suppress a different number of claims,
      // and evidence is part of the store's (node_id, kind, evidence)
      // uniqueness key — a count-bearing string would insert a NEW row per
      // distinct N instead of updating the existing digest row in place.
      evidence: `${sample.evidence} …and similar claims suppressed`,
      source: meta.source,
      suppressedCount: list.length,
    });
    suppressed += list.length;
  }

  return { kept, digests, suppressed };
}

/**
 * Pure counts describing a session's flag state - deliberately NOT a score
 * or grade (design principle #3: verifiable over probabilistic). Reads the
 * session's nodes (each carrying its `flags`) from the store and buckets
 * every flag row exactly once:
 *   - dismissed flags always count toward `dismissed`, regardless of tier
 *     or auto-resolved state (dismissal is the strongest user signal).
 *   - among the rest, verified flags split into `verifiedActive` /
 *     `verifiedResolved` (auto-resolved); advisory flags - which the T1
 *     auto-resolver never touches - all count as `advisoryActive`.
 *   - `suppressed` sums `suppressedCount` across every flag row in the
 *     session (digest rows carry the collapsed count; ordinary rows are 0).
 * `turns` counts prompt-kind nodes in the session.
 */
export function getSessionHealth(store: GraphStore, sessionId: string): SessionHealth {
  const nodes: ChronoNode[] = store.getSessionNodes(sessionId);

  let turns = 0;
  let verifiedActive = 0;
  let verifiedResolved = 0;
  let advisoryActive = 0;
  let dismissed = 0;
  let suppressed = 0;

  for (const node of nodes) {
    if (node.kind === "prompt") turns += 1;
    for (const flag of node.flags ?? []) {
      suppressed += flag.suppressedCount ?? 0;
      if (flag.dismissed) {
        dismissed += 1;
        continue;
      }
      if (flag.tier === "verified") {
        if (flag.autoResolved) verifiedResolved += 1;
        else verifiedActive += 1;
      } else {
        advisoryActive += 1;
      }
    }
  }

  return { sessionId, turns, verifiedActive, verifiedResolved, advisoryActive, dismissed, suppressed };
}
