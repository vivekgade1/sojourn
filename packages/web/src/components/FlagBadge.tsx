import type { StoredFlag } from "../types";

export interface FlagBadgeProps {
  flags: StoredFlag[];
}

/**
 * Verified vs advisory must NEVER be visually confusable:
 * - verified (tier "verified"): solid, confident red badge with a count.
 * - advisory (tier "advisory"): muted amber OUTLINE badge.
 * A mixed set of flags always renders as "verified" — a proven issue must
 * never be hidden behind a merely-advisory count.
 */
export function FlagBadge({ flags }: FlagBadgeProps) {
  const active = flags.filter((f) => !f.dismissed);
  if (active.length === 0) return null;

  const hasVerified = active.some((f) => f.tier === "verified");
  const variant = hasVerified ? "verified" : "advisory";

  const verifiedCount = active.filter((f) => f.tier === "verified").length;
  const advisoryCount = active.filter((f) => f.tier === "advisory").length;

  const label = hasVerified
    ? `${verifiedCount} verified${advisoryCount > 0 ? ` + ${advisoryCount} advisory` : ""}`
    : `${advisoryCount} advisory`;

  return (
    <span
      data-testid="flag-badge"
      className={`flag-badge flag-badge-${variant}`}
      title={label}
    >
      <span className="flag-badge-count">{active.length}</span>
    </span>
  );
}
