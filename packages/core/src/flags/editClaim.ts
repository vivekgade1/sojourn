import path from "node:path";
import type { ChronoNode, FileChange, Flag } from "../types.js";
import type { CheckContext, FlagCheck } from "../interfaces.js";
import { extractEditClaims, getNodeText, type ClaimKind } from "./claims.js";

function basename(p: string): string {
  return path.posix.basename(p);
}

/** Find diff entries matching a claimed path, allowing a basename fallback
 * only when the claim itself is a bare filename (no `/`) and exactly one
 * diff path shares that basename. A rename's `oldPath` satisfies only
 * claims about the file LEAVING that path: RENAME ("renamed"/"moved") and
 * DELETE (the file is genuinely gone from there). A plain EDIT claim is
 * NOT accounted for by an unrelated rename that happens to move the
 * claimed path away — EDIT matches the diff's `path` only (round-2 fix for
 * the oldPath over-match), and CREATE still requires the new path itself. */
function resolveDiffMatches(claimPath: string, diff: FileChange[], kind: ClaimKind): FileChange[] {
  const exact = diff.filter(
    (d) =>
      d.path === claimPath ||
      ((kind === "RENAME" || kind === "DELETE") && d.oldPath === claimPath),
  );
  if (exact.length > 0) return exact;

  if (!claimPath.includes("/")) {
    const byBasename = diff.filter((d) => basename(d.path) === claimPath);
    if (byBasename.length === 1) return byBasename;
  }
  return [];
}

export const editClaimCheck: FlagCheck = {
  kind: "edit_claim_mismatch",

  appliesTo(node: ChronoNode): boolean {
    return node.kind === "assistant" && getNodeText(node) !== null;
  },

  async run(ctx: CheckContext): Promise<Flag[]> {
    // No ground truth available: stay silent.
    if (ctx.nodeTree === null || ctx.parentTree === null) return [];

    const text = getNodeText(ctx.node);
    if (text === null) return [];

    const claims = extractEditClaims(text);
    if (claims.length === 0) return [];

    const flags: Flag[] = [];

    for (const claim of claims) {
      const matches = resolveDiffMatches(claim.path, ctx.diff, claim.kind);

      if (ctx.diff.length === 0) {
        // No diff at all: every edit claim gets a high flag naming its path.
        flags.push(mismatchFlag(claim.kind, claim.path, "high", "the snapshot diff for this step is empty"));
        continue;
      }

      if (claim.kind === "EDIT" || claim.kind === "RENAME") {
        if (matches.length === 0) {
          flags.push(
            mismatchFlag(
              claim.kind,
              claim.path,
              "high",
              claim.kind === "RENAME"
                ? "snapshot diff shows no rename or change of that file"
                : "snapshot diff shows no change to that file",
            ),
          );
        }
        continue;
      }

      if (claim.kind === "CREATE") {
        const added = matches.filter((m) => m.status === "A");
        if (added.length > 0) continue;
        const modified = matches.filter((m) => m.status === "M");
        if (modified.length > 0) {
          flags.push(
            mismatchFlag(
              claim.kind,
              claim.path,
              "medium",
              "snapshot diff shows that file only modified, not added",
            ),
          );
        } else {
          flags.push(
            mismatchFlag(claim.kind, claim.path, "high", "snapshot diff shows no added file at that path"),
          );
        }
        continue;
      }

      if (claim.kind === "DELETE") {
        // A rename whose oldPath is the claimed file satisfies a DELETE
        // claim: the file no longer exists at that path.
        const deleted = matches.filter(
          (m) => m.status === "D" || (m.status === "R" && m.oldPath === claim.path),
        );
        if (deleted.length > 0) continue;
        flags.push(
          mismatchFlag(claim.kind, claim.path, "high", "snapshot diff shows no deletion of that file"),
        );
      }
    }

    return flags;
  },
};

function mismatchFlag(
  kind: ClaimKind,
  claimPath: string,
  confidence: "high" | "medium",
  groundTruth: string,
): Flag {
  const verbPhrase =
    kind === "CREATE"
      ? "claimed creation of"
      : kind === "DELETE"
        ? "claimed deletion of"
        : kind === "RENAME"
          ? "claimed rename of"
          : "claimed edit to";
  return {
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence,
    evidence: `${verbPhrase} \`${claimPath}\`; ${groundTruth}`,
    source: "deterministic",
  };
}
