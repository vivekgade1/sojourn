// Behavioral CSS-cascade tests. jsdom's getComputedStyle resolves stylesheet
// cascade for opacity/box-shadow/border-style (var() tokens are left literal,
// which is exactly what we string-match on). These lock in the review-fixed
// precedence collisions on `.sojourn-node`.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SojournNode } from "../src/components/SojournNode";
import type { ChronoNode } from "../src/types";

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css");

beforeAll(() => {
  const style = document.createElement("style");
  style.id = "sojourn-styles";
  style.textContent = readFileSync(cssPath, "utf8");
  document.head.appendChild(style);
});

afterEach(() => cleanup());

function makeNode(id: string, overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id,
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: "2026-01-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: `node ${id}`,
    content: null,
    flags: [],
    annotations: [],
    meta: { nativeUuid: id },
    ...overrides,
  };
}

const thinnedFields = { snapshotRef: "tree-gone", restorable: false } as const;
const restorableFields = { snapshotRef: "tree-abc", restorable: true } as const;

function nodeEl(node: ChronoNode, props: Record<string, unknown> = {}): HTMLElement {
  const { container } = render(<SojournNode node={node} {...props} />);
  return container.querySelector(".sojourn-node") as HTMLElement;
}

describe("CSS precedence — opacity: out-of-focus dim/recede must beat thinned's 0.6", () => {
  it("thinned alone resolves to 0.6", () => {
    const el = nodeEl(makeNode("t1", thinnedFields));
    expect(el.className).toMatch(/\bthinned\b/);
    expect(getComputedStyle(el).opacity).toBe("0.6");
  });

  it("thinned + dimmed resolves to 0.28 (dim wins)", () => {
    const el = nodeEl(makeNode("t2", thinnedFields), { dimmed: true });
    expect(el.className).toMatch(/\bthinned\b/);
    expect(el.className).toMatch(/\bdimmed\b/);
    expect(getComputedStyle(el).opacity).toBe("0.28");
  });

  it("thinned + receded resolves to 0.55 (recede wins)", () => {
    const el = nodeEl(makeNode("t3", thinnedFields), { receded: true });
    expect(el.className).toMatch(/\bthinned\b/);
    expect(el.className).toMatch(/\breceded\b/);
    expect(getComputedStyle(el).opacity).toBe("0.55");
  });
});

describe("CSS precedence — box-shadow: restore-ready ring must LAYER with trail/search glows", () => {
  it("restore-ready + search-hit keeps BOTH the inset ring and the search glow", () => {
    const el = nodeEl(makeNode("r1", restorableFields), { searchHit: true });
    const shadow = getComputedStyle(el).boxShadow;
    expect(shadow).toContain("var(--restore-halo)"); // the restore ring
    expect(shadow).toContain("var(--trail-glow)"); // the search glow
    expect(shadow).toContain(","); // both present, comma-separated
  });

  it("restore-ready + on-trail keeps BOTH the inset ring and the trail glow", () => {
    const el = nodeEl(makeNode("r2", restorableFields), { onTrail: true });
    const shadow = getComputedStyle(el).boxShadow;
    expect(shadow).toContain("var(--restore-halo)");
    expect(shadow).toContain("var(--trail-glow)");
    expect(shadow).toContain(",");
  });
});

describe("CSS precedence — border-style: thinned must NOT hijack CLI identity", () => {
  it("a thinned CLAUDE node keeps its solid border", () => {
    const el = nodeEl(makeNode("c1", { cli: "claude", ...thinnedFields }));
    expect(el.className).toMatch(/sojourn-node-cli-claude/);
    expect(el.className).toMatch(/\bthinned\b/);
    expect(getComputedStyle(el).borderTopStyle).toBe("solid");
  });

  it("a thinned OPENCODE node keeps its dashed border", () => {
    const el = nodeEl(makeNode("o1", { cli: "opencode", ...thinnedFields }));
    expect(el.className).toMatch(/sojourn-node-cli-opencode/);
    expect(getComputedStyle(el).borderTopStyle).toBe("dashed");
  });
});
