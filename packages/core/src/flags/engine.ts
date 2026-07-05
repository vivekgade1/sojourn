import type { ChronoNode, Flag, FlagKind, StoredFlag } from "../types.js";
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
 * Re-runs the T1 check that produced each earlier ACTIVE (non-dismissed,
 * not-yet-auto-resolved) flag in this session, evaluating the *originally
 * flagged node's claim* against the ground truth available at `node`
 * (i.e. `ctx`, which the caller builds for `node`'s tree/diff). If the
 * check no longer reproduces that flag kind for the original node's claim,
 * the flag is considered fixed and resolveFlag(id) is called.
 *
 * Returns the number of flags resolved.
 */
export async function autoResolveFlags(
  store: GraphStoreLike,
  node: ChronoNode,
  ctx: CheckContext,
): Promise<number> {
  const sessionNodes = await store.getSessionNodes(node.sessionId);
  const checksByKind = new Map<FlagKind, FlagCheck>(allT1Checks().map((c) => [c.kind, c]));

  let resolvedCount = 0;

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

      // Re-run the check for the originally-flagged node, but against the
      // ground truth (diff/tree/snapshotter/fetchJson) available at the
      // current node — this is what lets a later fix clear an earlier flag.
      const reEvalCtx: CheckContext = {
        ...ctx,
        node: priorNode,
        priorNodes: ctx.priorNodes,
      };

      const stillFlagged = await check.run(reEvalCtx);
      const stillHolds = stillFlagged.some((f) => f.kind === flag.kind);

      if (!stillHolds) {
        await store.resolveFlag(flag.id);
        resolvedCount += 1;
      }
    }
  }

  return resolvedCount;
}
