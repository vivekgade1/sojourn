import { useState } from "react";
import { api } from "../api";
import type { FileChange } from "../types";

export interface DiffViewProps {
  nodeId: string;
}

/** On-demand per-node diff: fetches the file-change list, and lets the user
 * drill into a single file's patch text. */
export function DiffView({ nodeId }: DiffViewProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<FileChange[] | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);

  async function loadDiff() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDiff(nodeId);
      setChanges(res.changes);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function openFile(path: string) {
    if (openPath === path) {
      setOpenPath(null);
      setPatch(null);
      return;
    }
    setOpenPath(path);
    setPatch(null);
    try {
      const res = await api.getFileDiff(nodeId, path);
      setPatch(res.patch);
    } catch (e) {
      setPatch(`Error loading patch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (changes === null) {
    return (
      <button className="payload-toggle" onClick={loadDiff} disabled={loading}>
        {loading ? "Loading diff…" : "Load diff"}
      </button>
    );
  }

  if (error) {
    return <div className="flag-evidence">Failed to load diff: {error}</div>;
  }

  if (changes.length === 0) {
    return <div className="inspector-meta">No file changes (no snapshots to compare).</div>;
  }

  return (
    <div>
      {changes.map((change) => (
        <div key={change.path}>
          <button
            className={`diff-file diff-status-${change.status}`}
            onClick={() => openFile(change.path)}
          >
            [{change.status}] {change.path}
            {change.oldPath ? ` (from ${change.oldPath})` : ""}
          </button>
          {openPath === change.path && (
            <pre className="payload-json">{patch ?? "Loading…"}</pre>
          )}
        </div>
      ))}
    </div>
  );
}
