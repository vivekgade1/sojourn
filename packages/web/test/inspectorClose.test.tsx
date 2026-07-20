import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Inspector } from "../src/components/Inspector";
import type { ChronoNode } from "../src/types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function makeNode(id: string, overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id,
    parentId: null,
    kind: "tool_use",
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

describe("Inspector close control", () => {
  it("renders a labelled close button and fires onClose when clicked", () => {
    const onClose = vi.fn();
    render(<Inspector node={makeNode("claude:a")} {...noopHandlers} onClose={onClose} />);

    const button = screen.getByRole("button", { name: /close inspector/i });
    fireEvent.click(button);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits the close button entirely when no onClose is wired", () => {
    render(<Inspector node={makeNode("claude:a")} {...noopHandlers} />);
    expect(screen.queryByRole("button", { name: /close inspector/i })).toBeNull();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Inspector node={makeNode("claude:a")} {...noopHandlers} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The restore/harvest/combine modals do not handle Escape themselves. Without
  // the guard, Escape would dismiss the panel BEHIND a modal that stays on
  // screen, stranding the user in a flow whose context just vanished.
  it("does NOT close on Escape while a modal is open", () => {
    const onClose = vi.fn();
    render(<Inspector node={makeNode("claude:a")} {...noopHandlers} onClose={onClose} />);

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.appendChild(overlay);
    try {
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      overlay.remove();
    }

    // ...and works again once the modal is gone.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const onClose = vi.fn();
    render(<Inspector node={makeNode("claude:a")} {...noopHandlers} onClose={onClose} />);

    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("detaches its key listener on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Inspector node={makeNode("claude:a")} {...noopHandlers} onClose={onClose} />,
    );
    unmount();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

const noopHandlers = {
  onFlagDismissed: () => {},
  onAnnotationAdded: () => {},
};
