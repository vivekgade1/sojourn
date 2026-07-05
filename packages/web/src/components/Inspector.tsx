import { useState } from "react";
import { api } from "../api";
import type { ChronoNode, RestorePreflight, RestoreResult, StoredFlag } from "../types";
import { DiffView } from "./DiffView";

export interface InspectorProps {
  node: ChronoNode | null;
  onFlagDismissed: (nodeId: string, flagId: number) => void;
}

function FlagRow({
  flag,
  onDismiss,
}: {
  flag: StoredFlag;
  onDismiss: (flagId: number) => void;
}) {
  const [dismissing, setDismissing] = useState(false);

  async function handleDismiss() {
    setDismissing(true);
    try {
      await api.dismissFlag(flag.id);
      onDismiss(flag.id);
    } finally {
      setDismissing(false);
    }
  }

  if (flag.dismissed) return null;

  return (
    <div className={`flag-row flag-row-${flag.tier}`}>
      <div className="flag-row-header">
        <span className={`flag-tier-label ${flag.tier}`}>
          {flag.tier === "verified" ? "Verified" : "Advisory"}
        </span>
        <span className="inspector-meta">{flag.kind.replace(/_/g, " ")}</span>
      </div>
      <div className="flag-evidence">{flag.evidence}</div>
      <button className="dismiss-btn" onClick={handleDismiss} disabled={dismissing}>
        {dismissing ? "Dismissing…" : "Dismiss"}
      </button>
    </div>
  );
}

function RestoreFlow({ node }: { node: ChronoNode }) {
  const [preflight, setPreflight] = useState<RestorePreflight | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startPreflight() {
    setBusy(true);
    setError(null);
    try {
      const pf = await api.preflight(node.id);
      setPreflight(pf);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRestore() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.restore(node.id);
      setResult(res);
      setPreflight(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inspector-section">
      <h3>Restore</h3>
      <button className="restore-btn" onClick={startPreflight} disabled={busy}>
        {busy ? "Checking…" : "Restore to just before this"}
      </button>
      {error && <div className="flag-evidence">{error}</div>}

      {preflight && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>Confirm restore</h3>
            {!preflight.treeValid && (
              <div className="flag-evidence">
                Snapshot is no longer valid for this node — restore is unavailable.
              </div>
            )}
            {preflight.warnings.length > 0 && (
              <>
                <p>These side effects will NOT be undone:</p>
                <ul className="modal-warnings">
                  {preflight.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setPreflight(null)}>
                Cancel
              </button>
              <button
                className="modal-confirm"
                onClick={confirmRestore}
                disabled={!preflight.treeValid || busy}
              >
                {busy ? "Restoring…" : "Confirm restore"}
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="restore-result">
          <div>Worktree:</div>
          <code>{result.worktreePath}</code>
          {result.resumeCommand && (
            <>
              <div style={{ marginTop: 6 }}>Resume command:</div>
              <code>{result.resumeCommand}</code>
            </>
          )}
          {result.warnings.length > 0 && (
            <ul className="modal-warnings">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Inspector({ node, onFlagDismissed }: InspectorProps) {
  const [payloadOpen, setPayloadOpen] = useState(false);

  if (!node) {
    return <div className="inspector-empty">Select a node to inspect it.</div>;
  }

  const flags = (node.flags ?? []).filter((f) => !f.dismissed);

  return (
    <div className="inspector" data-testid="inspector">
      <h2>{node.label ?? node.kind}</h2>
      <div className="inspector-meta">
        {node.cli} · {node.kind} · {new Date(node.timestamp).toLocaleString()}
      </div>

      <div className="inspector-section">
        <h3>Summary</h3>
        <div>{node.summary}</div>
      </div>

      <div className="inspector-section">
        <h3>Payload</h3>
        <button className="payload-toggle" onClick={() => setPayloadOpen((v) => !v)}>
          {payloadOpen ? "Hide raw payload" : "Show raw payload"}
        </button>
        {payloadOpen && <pre className="payload-json">{JSON.stringify(node.content, null, 2)}</pre>}
      </div>

      <div className="inspector-section">
        <h3>Diff</h3>
        <DiffView nodeId={node.id} />
      </div>

      <div className="inspector-section">
        <h3>Flags{flags.length > 0 ? ` (${flags.length})` : ""}</h3>
        {flags.length === 0 && <div className="inspector-meta">No active flags.</div>}
        {flags.map((flag) => (
          <FlagRow
            key={flag.id}
            flag={flag}
            onDismiss={(flagId) => onFlagDismissed(node.id, flagId)}
          />
        ))}
      </div>

      <RestoreFlow node={node} />
    </div>
  );
}
