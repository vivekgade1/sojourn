import { useState } from "react";
import { api } from "../api";
import type { Annotation, ChronoNode, RestorePreflight, RestoreResult, StoredFlag } from "../types";
import { DiffView } from "./DiffView";

export interface InspectorProps {
  node: ChronoNode | null;
  onFlagDismissed: (nodeId: string, flagId: number) => void;
  onAnnotationAdded: (nodeId: string, annotation: Annotation) => void;
  /** Called with a node's FULL current flag list (replace, never merge). */
  onFlagsUpdated?: (nodeId: string, flags: StoredFlag[]) => void;
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

  // Auto-resolved flags render in a visually "resolved" state — muted and
  // struck through, explicitly labeled — so a settled issue can never be
  // mistaken for an active one.
  if (flag.autoResolved) {
    return (
      <div
        className={`flag-row flag-row-${flag.tier} flag-row-resolved`}
        style={{ opacity: 0.55 }}
        data-testid="flag-row-resolved"
      >
        <div className="flag-row-header">
          <span className={`flag-tier-label ${flag.tier}`}>
            {flag.tier === "verified" ? "Verified" : "Advisory"}
          </span>
          <span className="inspector-meta">{flag.kind.replace(/_/g, " ")}</span>
          <span className="flag-resolved-label">auto-resolved</span>
        </div>
        <div className="flag-evidence" style={{ textDecoration: "line-through" }}>
          {flag.evidence}
        </div>
      </div>
    );
  }

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

function AnnotationsSection({
  node,
  onAnnotationAdded,
}: {
  node: ChronoNode;
  onAnnotationAdded: (nodeId: string, annotation: Annotation) => void;
}) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const annotations = node.annotations ?? [];

  async function handleAdd() {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const annotation = await api.addAnnotation(node.id, trimmed);
      onAnnotationAdded(node.id, annotation);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="inspector-section">
      <h3>Annotations{annotations.length > 0 ? ` (${annotations.length})` : ""}</h3>
      {annotations.length === 0 && <div className="inspector-meta">No annotations yet.</div>}
      {annotations.map((a) => (
        <div className="annotation-row" key={a.id}>
          <div className="annotation-text">{a.text}</div>
          <div className="inspector-meta">{new Date(a.createdAt).toLocaleString()}</div>
        </div>
      ))}
      {error && <div className="flag-evidence">{error}</div>}
      <div className="annotation-input-row">
        <input
          type="text"
          className="annotation-input"
          placeholder="Add an annotation…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
        />
        <button
          className="primary-btn"
          onClick={handleAdd}
          disabled={submitting || text.trim().length === 0}
        >
          {submitting ? "Adding…" : "Add"}
        </button>
      </div>
    </div>
  );
}

interface RestoreFlowProps {
  /** The node id whose snapshot the restore actually targets. */
  targetNodeId: string;
  /** Button label — must truthfully describe WHERE the restore lands. */
  buttonLabel: string;
  /** One-line explanation shown in the confirm modal. */
  modalDescription: string;
  /** Optional section heading; omit to render the buttons inline (flag context). */
  heading?: string;
}

function RestoreFlow({ targetNodeId, buttonLabel, modalDescription, heading }: RestoreFlowProps) {
  const [preflight, setPreflight] = useState<RestorePreflight | null>(null);
  // The node id captured at the moment preflight was requested. This is the
  // ONLY id ever passed to api.restore — never the (possibly-changed)
  // target prop — so that even if this component instance somehow survived
  // a node switch, the confirm action can't act on a different node than
  // the one whose warnings the user actually reviewed.
  const [preflightNodeId, setPreflightNodeId] = useState<string | null>(null);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startPreflight() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const pf = await api.preflight(targetNodeId);
      setPreflight(pf);
      setPreflightNodeId(targetNodeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRestore() {
    if (busy) return;
    if (!preflightNodeId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.restore(preflightNodeId);
      setResult(res);
      setPreflight(null);
      setPreflightNodeId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={heading ? "inspector-section" : "restore-inline"}>
      {heading && <h3>{heading}</h3>}
      <button className="restore-btn" onClick={startPreflight} disabled={busy}>
        {busy ? "Checking…" : buttonLabel}
      </button>
      {error && <div className="flag-evidence">{error}</div>}

      {preflight && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>Confirm restore</h3>
            <p>{modalDescription}</p>
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
              <button
                className="modal-cancel"
                onClick={() => {
                  setPreflight(null);
                  setPreflightNodeId(null);
                }}
              >
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

function InspectorContent({
  node,
  onFlagDismissed,
  onAnnotationAdded,
  onFlagsUpdated,
}: InspectorProps & { node: ChronoNode }) {
  const [payloadOpen, setPayloadOpen] = useState(false);
  const [criticBusy, setCriticBusy] = useState(false);
  const [criticError, setCriticError] = useState<string | null>(null);
  const [criticRan, setCriticRan] = useState(false);
  // Local fallback so the advisory results render even without a parent
  // onFlagsUpdated wiring (e.g. when rendered in isolation). When the
  // parent DOES wire onFlagsUpdated, node.flags is the single source of
  // truth — the local copy is ignored so later parent updates (dismissals,
  // WS flags_updated) are never shadowed by a stale local list.
  const [localFlags, setLocalFlags] = useState<StoredFlag[] | null>(null);

  const allFlags = (onFlagsUpdated ? node.flags : (localFlags ?? node.flags)) ?? [];
  const activeFlags = allFlags.filter((f) => !f.dismissed && !f.autoResolved);
  const resolvedFlags = allFlags.filter((f) => !f.dismissed && f.autoResolved);

  async function runAdvisoryCritic() {
    if (criticBusy) return;
    setCriticBusy(true);
    setCriticError(null);
    try {
      const res = await api.runFlags(node.id, "T2");
      // The daemon returns the node's FULL current flag list.
      setLocalFlags(res.flags);
      setCriticRan(true);
      onFlagsUpdated?.(node.id, res.flags);
    } catch (e) {
      // e.g. 400 "T2 requires ANTHROPIC_API_KEY", 502 on critic failure —
      // shown as-is, never styled like a flag.
      setCriticError(e instanceof Error ? e.message : String(e));
    } finally {
      setCriticBusy(false);
    }
  }

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
        <h3>Flags{activeFlags.length > 0 ? ` (${activeFlags.length})` : ""}</h3>
        {activeFlags.length === 0 && <div className="inspector-meta">No active flags.</div>}
        {activeFlags.map((flag) => (
          <FlagRow
            key={flag.id}
            flag={flag}
            onDismiss={(flagId) => onFlagDismissed(node.id, flagId)}
          />
        ))}
        {resolvedFlags.map((flag) => (
          <FlagRow
            key={flag.id}
            flag={flag}
            onDismiss={(flagId) => onFlagDismissed(node.id, flagId)}
          />
        ))}

        {node.kind === "assistant" && (
          <div className="critic-row">
            <button
              className="critic-btn"
              onClick={runAdvisoryCritic}
              disabled={criticBusy}
            >
              {criticBusy ? "Running critic…" : "Run advisory critic"}
            </button>
            {criticError && <div className="inspector-meta">{criticError}</div>}
            {criticRan && !criticError && allFlags.filter((f) => f.tier === "advisory").length === 0 && (
              <div className="inspector-meta">Critic ran — no advisory flags.</div>
            )}
          </div>
        )}

        {activeFlags.length > 0 && (
          <RestoreFlow
            // A flagged node means "this step went wrong" — the useful
            // rollback is to the state BEFORE this node, i.e. its parent's
            // snapshot. Root nodes (no parent) fall back to the node itself.
            targetNodeId={node.parentId ?? node.id}
            buttonLabel="Restore to before this node"
            modalDescription={
              node.parentId
                ? "This restores the files to the state just before this node (its parent's snapshot), into a new worktree."
                : "This node has no parent — this restores the files to this node's own snapshot, into a new worktree."
            }
          />
        )}
      </div>

      <AnnotationsSection node={node} onAnnotationAdded={onAnnotationAdded} />

      <RestoreFlow
        key={node.id}
        targetNodeId={node.id}
        heading="Restore"
        buttonLabel="Restore at this node"
        modalDescription="This restores the files exactly as they were AT this node's snapshot, into a new worktree."
      />
    </div>
  );
}

export function Inspector({ node, onFlagDismissed, onAnnotationAdded, onFlagsUpdated }: InspectorProps) {
  if (!node) {
    return <div className="inspector-empty">Select a node to inspect it.</div>;
  }

  // Key the entire inspector content by node.id: switching the selected node
  // must fully remount (not update) this subtree, so no state from the
  // previous node — especially in-flight restore-preflight state — can leak
  // across a node switch. Restoring the wrong node is a data-integrity bug.
  return (
    <InspectorContent
      key={node.id}
      node={node}
      onFlagDismissed={onFlagDismissed}
      onAnnotationAdded={onAnnotationAdded}
      onFlagsUpdated={onFlagsUpdated}
    />
  );
}
