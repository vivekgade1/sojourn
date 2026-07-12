import type { ChronoNode, FileChange, Flag, FlagKind, StoredFlag } from "../types.js";
import { allBacktickedTokens } from "./claims.js";
import type { CheckContext, FlagCheck } from "../interfaces.js";
import { editClaimCheck } from "./editClaim.js";
import { packagesCheck } from "./packages.js";
import { fileRefsCheck } from "./fileRefs.js";
import { symbolsCheck } from "./symbols.js";
import { testsCheck } from "./tests.js";

export function allT1Checks(): FlagCheck[] {
  return [editClaimCheck, packagesCheck, fileRefsCheck, symbolsCheck, testsCheck];
}

export class FlagEngine {
  private readonly checks: FlagCheck[];

  constructor(checks: FlagCheck[] = allT1Checks()) {
    this.checks = checks;
  }

  async runOnNode(ctx: CheckContext): Promise<Flag[]> {
    const applicable = this.checks.filter((check) => check.appliesTo(ctx.node));
    const results = await Promise.all(applicable.map((check) => check.run(ctx)));
    return results.flat();
  }
}

/**
 * Minimal structural interface for the graph store, defined locally so this
 * package doesn't depend on src/store (built in a parallel task). The real
 * GraphStore satisfies this shape structurally.
 */
export interface GraphStoreLike {
  getFlags(nodeId: string): StoredFlag[] | Promise<StoredFlag[]>;
  resolveFlag(id: number): void | Promise<void>;
  getSessionNodes(sessionId: string): ChronoNode[] | Promise<ChronoNode[]>;
}

/**
 * THE canonical definition of claim identity, shared by auto-resolve (below)
 * and per-turn dedup (`applyBudgets` in ./budget.ts) so "same claim" means
 * exactly one thing everywhere. Two flags are the same claim iff their keys
 * are equal: same `kind` AND same claimed subject. The subject is the FULL
 * ORDERED LIST of backtick-quoted tokens in the evidence string, falling
 * back to the exact evidence string when it has no backticked tokens at all
 * (the "T"/"E" prefix keeps those two namespaces from ever colliding, and
 * JSON.stringify makes the token list unambiguous even if a token contains
 * the join character).
 *
 * Using only the *first* backticked token is not enough: symbol_not_found's
 * evidence is "claimed symbol `sym` in `file`; ..." — if two flags on the
 * same node are about the SAME symbol name in TWO DIFFERENT files, comparing
 * only the first token (`sym`) would treat them as the same claim, so fixing
 * the symbol in one file would incorrectly auto-resolve the flag for the
 * other file too. The full ordered token list (`sym`, `file`) disambiguates
 * them while still letting a node with multiple flags of the same kind
 * (e.g. two edit_claim_mismatch flags for two different files) resolve
 * independently.
 */
export function claimIdentityKey(flag: Flag): string {
  const tokens = allBacktickedTokens(flag.evidence);
  return tokens.length > 0
    ? `${flag.kind}|T|${JSON.stringify(tokens)}`
    : `${flag.kind}|E|${flag.evidence}`;
}

function flagsMatchSameClaim(a: Flag, b: Flag): boolean {
  return claimIdentityKey(a) === claimIdentityKey(b);
}

/**
 * Kinds whose check selects candidates from `ctx.diff`/`ctx.parentTree` and
 * therefore goes SILENT (returns []) when `parentTree` is null — see
 * editClaimCheck's and packagesCheck's null-tree guards. That silence is
 * correct for FORWARD flagging (no ground truth => no new flag), but it is
 * NOT evidence a previously-flagged claim was fixed: a null re-eval base
 * means "cannot re-evaluate", not "condition no longer holds". Feeding it
 * into `check.run()` and reading the empty result as "resolved" would
 * silently clear real flags the moment a prior node has no ancestor prompt
 * snapshot. See the null-re-eval-base guard in the loop below.
 */
const DIFF_SCOPED_KINDS: ReadonlySet<FlagKind> = new Set(["edit_claim_mismatch", "package_hallucination"]);

/**
 * Re-runs the T1 check that produced each earlier ACTIVE (non-dismissed,
 * not-yet-auto-resolved) flag in this session, evaluating the *originally
 * flagged node's claim* against the ground truth available at `node`
 * (i.e. `ctx`, which the caller builds for `node`'s tree/diff). If the
 * check no longer reproduces that flag kind for the original node's claim,
 * the flag is considered fixed and resolveFlag(id) is called.
 *
 * RE-EVALUATION SPAN: diff-scoped checks (edit-claim, packages) only have
 * jurisdiction over files present in `ctx.diff`. Re-running them against the
 * CURRENT node's turn-scoped diff is wrong in both directions — a flag about
 * a file the latest turn didn't touch would spuriously auto-resolve (the
 * check sees no candidate files, so "the condition no longer holds"), and a
 * claim fixed two turns ago would never resolve (the fix isn't in the
 * current turn's diff, so the old claim re-flags). The correct span is the
 * OLD flag's turn base -> the CURRENT tree, so everything that happened
 * since the claim is visible. Callers supply `turnBaseOf` to map each prior
 * node to its own turn base tree; when it is absent, `ctx.parentTree` is
 * used (the legacy turn-scoped behavior). Span diffs are cached per base
 * across the loop, `ctx.diff` is reused when the base equals
 * `ctx.parentTree`, and a failing `snapshotter.diff` fails SOFT: resolution
 * is skipped for the affected flags (kept active), never thrown out.
 *
 * Returns the number of flags resolved. When `onResolved` is provided it is
 * called once per resolved flag with the flag's node id and flag id, so
 * callers (e.g. the daemon's ingest pipeline) can re-broadcast the affected
 * nodes' full flag lists. A throwing `onResolved` never aborts the pass.
 */
export async function autoResolveFlags(
  store: GraphStoreLike,
  node: ChronoNode,
  ctx: CheckContext,
  onResolved?: (nodeId: string, flagId: number) => void,
  turnBaseOf?: (node: ChronoNode) => string | null,
): Promise<number> {
  const sessionNodes = await store.getSessionNodes(node.sessionId);
  const checksByKind = new Map<FlagKind, FlagCheck>(allT1Checks().map((c) => [c.kind, c]));

  let resolvedCount = 0;

  // Span-diff cache keyed by turn-base tree (many prior nodes share a turn
  // base). `null` marks a failed diff for that base: fail soft — skip
  // resolution for every flag grounded on it, keep the flags active.
  const spanDiffByBase = new Map<string | null, FileChange[] | null>();

  async function spanDiffFor(base: string | null): Promise<FileChange[] | null> {
    if (base === ctx.parentTree) return ctx.diff;
    if (ctx.snapshotter === null || ctx.nodeTree === null) return ctx.diff;
    if (spanDiffByBase.has(base)) return spanDiffByBase.get(base) ?? null;
    let result: FileChange[] | null;
    try {
      result = await ctx.snapshotter.diff(base, ctx.nodeTree);
    } catch {
      result = null;
    }
    spanDiffByBase.set(base, result);
    return result;
  }

  for (const priorNode of sessionNodes) {
    if (priorNode.id === node.id) continue;
    const flags = await store.getFlags(priorNode.id);
    for (const flag of flags) {
      if (flag.dismissed) continue;
      if (flag.autoResolved) continue;
      if (flag.source !== "deterministic") continue; // T1 auto-resolve only

      const check = checksByKind.get(flag.kind);
      if (!check) continue;
      if (!check.appliesTo(priorNode)) continue;

      // Re-run the check for the originally-flagged node against the ground
      // truth at the current node, spanning from the PRIOR node's own turn
      // base so intermediate turns' changes are visible.
      const base = turnBaseOf ? turnBaseOf(priorNode) : ctx.parentTree;

      // A null base for a diff-scoped check's kind means "cannot
      // re-evaluate" (no ancestor prompt snapshot to span from), not "the
      // claim is fixed" — the check's own null-tree guard would return []
      // regardless of ground truth, and reading that as "no longer holds"
      // would wrongly auto-resolve a still-active flag. Fail soft: skip
      // resolution, keep the flag active, same contract as a throwing span
      // diff below.
      if (base === null && DIFF_SCOPED_KINDS.has(flag.kind)) continue;

      const spanDiff = await spanDiffFor(base);
      if (spanDiff === null) continue; // diff failed: never resolve blind

      const reEvalCtx: CheckContext = {
        ...ctx,
        node: priorNode,
        parentTree: base,
        diff: spanDiff,
        priorNodes: ctx.priorNodes,
      };

      const stillFlagged = await check.run(reEvalCtx);

      // DIGEST flags (suppressedCount > 0) get GROUP semantics, not
      // per-claim matching. A digest's evidence names only its SAMPLE
      // claim — the suppressedCount other claims it stands in for were
      // never persisted, so their identities are unrecoverable here.
      // Matching per-claim would auto-resolve the whole digest the moment
      // the sample alone is fixed, silently eating the suppressed true
      // positives. Instead, a digest "still holds" while the re-run check
      // produces ANY flag of the same kind+tier at all; it resolves only
      // when its entire kind+tier group clears at re-evaluation.
      const isDigest = (flag.suppressedCount ?? 0) > 0;
      const stillHolds = isDigest
        ? stillFlagged.some((f) => f.kind === flag.kind && f.tier === flag.tier)
        : stillFlagged.some((f) => flagsMatchSameClaim(f, flag));

      if (!stillHolds) {
        await store.resolveFlag(flag.id);
        resolvedCount += 1;
        if (onResolved) {
          try {
            onResolved(priorNode.id, flag.id);
          } catch {
            // observer must never break the auto-resolve pass
          }
        }
      }
    }
  }

  return resolvedCount;
}
