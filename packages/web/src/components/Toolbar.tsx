import type { SessionOption } from "../sessions";
import type { Project } from "../types";
import { SessionFilter } from "./SessionFilter";

export interface ToolbarProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  view: "map" | "graph";
  onSetView: (view: "map" | "graph") => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  decisionLens: boolean;
  onToggleDecisionLens: () => void;
  flaggedOnly: boolean;
  onToggleFlaggedOnly: () => void;
  restorableOnly: boolean;
  onToggleRestorableOnly: () => void;
  wsConnected: boolean;
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  matchCount: number;
  activeMatchIndex: number; // 0-based; -1 when none
  onCycleMatch: (direction: 1 | -1) => void;
  sessions: SessionOption[];
  selectedSessionIds: Set<string>;
  onSessionSelectionChange: (ids: string[]) => void;
}

export function Toolbar({
  projects,
  selectedProjectId,
  onSelectProject,
  view,
  onSetView,
  theme,
  onToggleTheme,
  decisionLens,
  onToggleDecisionLens,
  flaggedOnly,
  onToggleFlaggedOnly,
  restorableOnly,
  onToggleRestorableOnly,
  wsConnected,
  searchQuery,
  onSearchQueryChange,
  matchCount,
  activeMatchIndex,
  onCycleMatch,
  sessions,
  selectedSessionIds,
  onSessionSelectionChange,
}: ToolbarProps) {
  const searching = searchQuery.trim().length > 0;
  return (
    <div className="toolbar" data-testid="toolbar">
      <span className="toolbar-brand">
        Sojourn<span className="toolbar-brand-dot">.</span>
      </span>

      <select
        aria-label="Project"
        value={selectedProjectId ?? ""}
        onChange={(e) => onSelectProject(e.target.value)}
      >
        {projects.length === 0 && <option value="">No projects</option>}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <div className="view-switch" role="group" aria-label="View">
        <button
          className={view === "map" ? "active" : ""}
          onClick={() => onSetView("map")}
          aria-pressed={view === "map"}
        >
          Map
        </button>
        <button
          className={view === "graph" ? "active" : ""}
          onClick={() => onSetView("graph")}
          aria-pressed={view === "graph"}
        >
          Graph
        </button>
      </div>

      <SessionFilter
        sessions={sessions}
        selectedIds={selectedSessionIds}
        onChange={onSessionSelectionChange}
      />

      <div className={`toolbar-search${searching ? " active" : ""}`}>
        <input
          type="search"
          aria-label="Search nodes"
          placeholder="Search nodes — gist, kind, tool, id…"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCycleMatch(e.shiftKey ? -1 : 1);
            }
            if (e.key === "Escape") onSearchQueryChange("");
          }}
        />
        {searching && (
          <span className="toolbar-search-count" data-testid="search-count">
            {matchCount === 0 ? "0 matches" : `${activeMatchIndex + 1} / ${matchCount}`}
          </span>
        )}
        {searching && matchCount > 0 && (
          <span className="toolbar-search-nav">
            <button aria-label="Previous match" onClick={() => onCycleMatch(-1)}>‹</button>
            <button aria-label="Next match" onClick={() => onCycleMatch(1)}>›</button>
          </span>
        )}
      </div>

      <label className={`toolbar-toggle${decisionLens ? " active" : ""}`}>
        <input type="checkbox" checked={decisionLens} onChange={onToggleDecisionLens} />
        Decision lens
      </label>

      <label className={`toolbar-toggle${flaggedOnly ? " active" : ""}`}>
        <input type="checkbox" checked={flaggedOnly} onChange={onToggleFlaggedOnly} />
        Flagged only
      </label>

      <label className={`toolbar-toggle${restorableOnly ? " active action" : ""}`}>
        <input type="checkbox" checked={restorableOnly} onChange={onToggleRestorableOnly} />
        Restorable
      </label>

      <span className={`toolbar-status${wsConnected ? " live" : ""}`}>
        {wsConnected ? "live" : "disconnected"}
      </span>

      <button
        className="theme-toggle"
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>
    </div>
  );
}
