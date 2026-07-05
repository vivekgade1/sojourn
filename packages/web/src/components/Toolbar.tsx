import type { Project } from "../types";

export interface ToolbarProps {
  projects: Project[];
  selectedProjectId: string | null;
  onSelectProject: (id: string) => void;
  decisionLens: boolean;
  onToggleDecisionLens: () => void;
  flaggedOnly: boolean;
  onToggleFlaggedOnly: () => void;
  wsConnected: boolean;
}

export function Toolbar({
  projects,
  selectedProjectId,
  onSelectProject,
  decisionLens,
  onToggleDecisionLens,
  flaggedOnly,
  onToggleFlaggedOnly,
  wsConnected,
}: ToolbarProps) {
  return (
    <div className="toolbar" data-testid="toolbar">
      <span className="toolbar-brand">Sojourn</span>

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

      <label className={`toolbar-toggle${decisionLens ? " active" : ""}`}>
        <input type="checkbox" checked={decisionLens} onChange={onToggleDecisionLens} />
        Decision lens
      </label>

      <label className={`toolbar-toggle${flaggedOnly ? " active" : ""}`}>
        <input type="checkbox" checked={flaggedOnly} onChange={onToggleFlaggedOnly} />
        Flagged only
      </label>

      <span className="toolbar-status">{wsConnected ? "live" : "disconnected"}</span>
    </div>
  );
}
