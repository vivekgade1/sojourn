import { useEffect, useRef, useState } from "react";
import type { SessionOption } from "../sessions";

export interface SessionFilterProps {
  /** Newest-first (same order buildJourneys emits). */
  sessions: SessionOption[];
  /** The EFFECTIVE selection (already defaulted/validated by the App). */
  selectedIds: Set<string>;
  /** Emits the raw chosen ids; the App resolves defaults + persistence. */
  onChange: (ids: string[]) => void;
}

/**
 * Toolbar popover for choosing which sessions the map/graph show. Defaults
 * to the newest session only (the App enforces that); "All" opts into the
 * full expedition history.
 */
export function SessionFilter({ sessions, selectedIds, onChange }: SessionFilterProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape while open.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const allSelected = sessions.length > 0 && sessions.every((s) => selectedIds.has(s.sessionId));

  function toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // Emptying the selection is allowed — the App falls back to latest-only.
    onChange([...next]);
  }

  return (
    <div className="session-filter" ref={rootRef} data-testid="session-filter">
      <button
        className={`session-filter-button${open ? " open" : ""}`}
        data-testid="session-filter-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        sessions {selectedIds.size}/{sessions.length}
      </button>
      {open && (
        <div className="session-filter-panel" role="group" aria-label="Session filter">
          <div className="session-filter-actions">
            <button
              className="session-filter-all"
              onClick={() => onChange(sessions.map((s) => s.sessionId))}
              disabled={allSelected}
            >
              All
            </button>
            <span className="session-filter-hint">newest first · latest only by default</span>
          </div>
          {sessions.length === 0 && <div className="session-filter-empty">No sessions yet.</div>}
          {sessions.map((s) => {
            const started = new Date(s.startedAt);
            return (
              <label key={s.sessionId} className="session-filter-row" data-testid="session-filter-row">
                <input
                  type="checkbox"
                  checked={selectedIds.has(s.sessionId)}
                  onChange={() => toggle(s.sessionId)}
                />
                <span className="session-filter-when">
                  {started.toLocaleDateString()}{" "}
                  {started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="session-filter-meta">
                  {s.turnCount} turn{s.turnCount === 1 ? "" : "s"} · {s.cli}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
