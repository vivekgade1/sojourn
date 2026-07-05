import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FlagBadge } from "../src/components/FlagBadge";
import type { StoredFlag } from "../src/types";

afterEach(() => {
  cleanup();
});

function makeFlag(overrides: Partial<StoredFlag> = {}): StoredFlag {
  return {
    id: 1,
    nodeId: "claude:1",
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence: "high",
    evidence: "claimed edit to auth.py; snapshot diff shows no change",
    source: "deterministic",
    dismissed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("FlagBadge", () => {
  it("renders a verified badge as solid/confident with a distinct class name", () => {
    const flags = [makeFlag({ tier: "verified" })];
    render(<FlagBadge flags={flags} />);

    const badge = screen.getByTestId("flag-badge");
    expect(badge.className).toMatch(/flag-badge-verified/);
    expect(badge.className).not.toMatch(/flag-badge-advisory/);
  });

  it("renders an advisory badge as muted/outline with a distinct class name", () => {
    const flags = [makeFlag({ tier: "advisory", source: "llm_critic", confidence: "low" })];
    render(<FlagBadge flags={flags} />);

    const badge = screen.getByTestId("flag-badge");
    expect(badge.className).toMatch(/flag-badge-advisory/);
    expect(badge.className).not.toMatch(/flag-badge-verified/);
  });

  it("verified and advisory badges never share the same class name", () => {
    const { unmount } = render(<FlagBadge flags={[makeFlag({ tier: "verified" })]} />);
    const verifiedClass = screen.getByTestId("flag-badge").className;
    unmount();

    render(<FlagBadge flags={[makeFlag({ tier: "advisory" })]} />);
    const advisoryClass = screen.getByTestId("flag-badge").className;

    expect(verifiedClass).not.toBe(advisoryClass);
  });

  it("shows the count of flags", () => {
    const flags = [makeFlag({ id: 1 }), makeFlag({ id: 2 }), makeFlag({ id: 3 })];
    render(<FlagBadge flags={flags} />);

    expect(screen.getByTestId("flag-badge").textContent).toContain("3");
  });

  it("counts verified and advisory separately when both are present, verified taking visual precedence", () => {
    const flags = [makeFlag({ id: 1, tier: "verified" }), makeFlag({ id: 2, tier: "advisory" })];
    render(<FlagBadge flags={flags} />);

    const badge = screen.getByTestId("flag-badge");
    // mixed set must read as verified (never let advisory hide a verified flag)
    expect(badge.className).toMatch(/flag-badge-verified/);
  });

  it("renders nothing when there are no flags", () => {
    const { container } = render(<FlagBadge flags={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
