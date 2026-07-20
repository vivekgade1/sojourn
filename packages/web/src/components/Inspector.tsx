import { useEffect, useState } from "react";
import { api, ApiError, isCombinePartial, isHarvestPartial } from "../api";
import type {
  Annotation,
  ChronoNode,
  CombinePartialState,
  CombinePreflight,
  CombineResult,
  HarvestOutcome,
  HarvestPartialState,
  HarvestPreflight,
  RestorePreflight,
  RestoreResult,
  StoredFlag,
} from "../types";
import { DiffView } from "./DiffView";

export interface InspectorProps {
  node: ChronoNode | null;
  onFlagDismissed: (nodeId: string, flagId: number) => void;
  onAnnotationAdded: (nodeId: string, annotation: Annotation) => void;
  /** Called with a node's FULL current flag list (replace, never merge). */
  onFlagsUpdated?: (nodeId: string, flags: StoredFlag[]) => void;
  /** Lineage from session root to this node (inclusive), for the Path section. */
  path?: ChronoNode[];
  /** Select (and pan to) another node — used by Path breadcrumb clicks. */
  onSelectNode?: (id: string) => void;
  /**
   * The node currently marked for combine, if any. Lives in App state (NOT
   * here) precisely so it survives both a selection change and a session-filter
   * change — marking in one session and combining into another is the point.
   * May be a node the session filter is currently hiding.
   */
  markedNode?: ChronoNode | null;
  /** Mark the inspected node as the combine partner. */
  onMarkForCombine?: (nodeId: string) => void;
  /**
   * Dismiss the panel. Clears the SELECTION at the App level (so the graph
   * reflows and lineage highlighting clears) — it does NOT unmark a node
   * marked for combine, which deliberately outlives selection changes.
   */
  onClose?: () => void;
}

/**
 * The textual twin of the graph's lit trail: how this node was reached,
 * root → here, each step clickable.
 */
function PathSection({
  path,
  currentId,
  onSelectNode,
}: {
  path: ChronoNode[];
  currentId: string;
  onSelectNode?: (id: string) => void;
}) {
  if (path.length <= 1) return null;
  return (
    <div className="inspector-section" data-testid="path-section">
      <h3>Path ({path.length} steps)</h3>
      <ol className="path-list">
        {path.map((step) => (
          <li key={step.id}>
            <button
              className={`path-crumb${step.id === currentId ? " current" : ""}`}
              onClick={() => onSelectNode?.(step.id)}
              title={step.summary}
            >
              <span className="legend-dot" style={{ background: `var(--kind-${step.kind})` }} />
              <span className="path-crumb-kind">{step.kind.replace(/_/g, " ")}</span>
              <span className="path-crumb-gist">{step.label ?? step.summary}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
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

const RESTORE_UNAVAILABLE_TITLE =
  "Snapshot unavailable — thinned by retention (soj gc) or never captured.";

interface RestoreFlowProps {
  /** The node id whose snapshot the restore actually targets. */
  targetNodeId: string;
  /** Button label — must truthfully describe WHERE the restore lands. */
  buttonLabel: string;
  /** One-line explanation shown in the confirm modal. */
  modalDescription: string;
  /** Optional section heading; omit to render the buttons inline (flag context). */
  heading?: string;
  /**
   * The TARGET node's restorability. `false` hard-disables the button (no
   * snapshot to land on); `true`/`undefined` leave it enabled (undefined is the
   * backward-safe unknown case — never disable on a missing field).
   */
  restorable?: boolean;
}

function RestoreFlow({
  targetNodeId,
  buttonLabel,
  modalDescription,
  heading,
  restorable,
}: RestoreFlowProps) {
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

  // `restorable === false` means the target has no reachable snapshot — restore
  // is impossible, so the button is hard-disabled with an explanatory tooltip.
  // The in-modal `!treeValid` backstop below still guards the confirm action.
  const unrestorable = restorable === false;

  return (
    <div className={heading ? "inspector-section" : "restore-inline"}>
      {heading && <h3>{heading}</h3>}
      <button
        className="restore-btn"
        onClick={startPreflight}
        disabled={unrestorable || busy}
        title={unrestorable ? RESTORE_UNAVAILABLE_TITLE : undefined}
      >
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
          {/* The restore's own worktreePath is the only place the web UI ever
              learns a worktree exists, so the harvest entry point belongs
              here and nowhere else. */}
          <HarvestFlow worktreePath={result.worktreePath} />
        </div>
      )}
    </div>
  );
}

/**
 * Recovery detail for a 500 (`partial_apply` / `mainline_drift`). This is NOT
 * a generic failure: the mainline WAS written to. The only useful thing to
 * show is exactly what landed, what never will, and the snapshot that holds
 * the pre-harvest state.
 */
function HarvestPartialReport({ partial }: { partial: HarvestPartialState }) {
  return (
    <div className="harvest-partial" data-testid="harvest-partial">
      <strong>Your project was modified before this failed.</strong>
      <div>
        {partial.applied.length} file(s) were written to your project, and{" "}
        {partial.remaining.length} were never processed. Nothing here is automatically
        undone.
      </div>
      {partial.applied.length > 0 && (
        <>
          <div className="harvest-partial-label">Applied to your project:</div>
          <ul className="modal-warnings" data-testid="harvest-partial-applied">
            {partial.applied.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {partial.conflicted.length > 0 && (
        <>
          <div className="harvest-partial-label">Conflicted:</div>
          <ul className="modal-warnings">
            {partial.conflicted.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      {partial.remaining.length > 0 && (
        <>
          <div className="harvest-partial-label">Never processed:</div>
          <ul className="modal-warnings" data-testid="harvest-partial-remaining">
            {partial.remaining.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </>
      )}
      <div className="harvest-partial-label">
        Recover your project from this pre-harvest snapshot:
      </div>
      <code data-testid="harvest-partial-snapshot">{partial.safetySnapshotRef}</code>
    </div>
  );
}

/**
 * Harvest: bring a restored worktree's changes back into the mainline project.
 *
 * Lives inside the restore RESULT block because `worktreePath` is the only
 * place the web UI ever learns a worktree exists — there is no other context
 * in the app that knows one.
 */
function HarvestFlow({ worktreePath }: { worktreePath: string }) {
  const [preflight, setPreflight] = useState<HarvestPreflight | null>(null);
  // The worktree path captured when preflight was requested — the ONLY value
  // ever passed to api.harvest, never the live prop, so confirming can't act
  // on a different worktree than the one whose files the user reviewed.
  const [preflightPath, setPreflightPath] = useState<string | null>(null);
  const [result, setResult] = useState<HarvestOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept alongside `error` so a mid-apply 500 can render its recovery detail
  // instead of a bare message. Null for every other failure.
  const [partial, setPartial] = useState<HarvestPartialState | null>(null);
  const [mode, setMode] = useState<"apply" | "patch">("apply");
  const [allowConflicts, setAllowConflicts] = useState(false);

  function noteError(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
    // `code`/`partial` are optional even on a 400 — a plain input-validation
    // rejection carries neither. Only a genuine mid-apply failure has partial,
    // and only a HARVEST-shaped one belongs in this report.
    const p = e instanceof ApiError ? e.partial : null;
    setPartial(p && isHarvestPartial(p) ? p : null);
  }

  async function startPreflight() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPartial(null);
    try {
      const pf = await api.harvestPreflight(worktreePath);
      setPreflight(pf);
      setPreflightPath(worktreePath);
    } catch (e) {
      noteError(e);
    } finally {
      setBusy(false);
    }
  }

  function closeModal() {
    setPreflight(null);
    setPreflightPath(null);
  }

  async function confirmHarvest() {
    if (busy) return;
    if (!preflightPath) return;
    setBusy(true);
    setError(null);
    setPartial(null);
    try {
      const res = await api.harvest(preflightPath, mode, allowConflicts);
      setResult(res);
      closeModal();
    } catch (e) {
      noteError(e);
    } finally {
      setBusy(false);
    }
  }

  const conflictCount = preflight?.files.filter((f) => f.status === "conflict").length ?? 0;
  // Mirrors the server's own refusal (harvestEngine.ts: apply-mode aborts
  // clean when any file conflicts unless allowConflicts). Patch mode returns
  // before that check ever runs — it never touches the mainline — so
  // conflicts must NOT block it.
  const confirmBlocked = mode === "apply" && conflictCount > 0 && !allowConflicts;

  return (
    <div className="harvest-flow" data-testid="harvest-flow">
      <button className="restore-btn" onClick={startPreflight} disabled={busy}>
        {busy ? "Checking…" : "Harvest changes into project"}
      </button>
      {error && (
        <div className="flag-evidence" data-testid="harvest-error">
          {error}
        </div>
      )}
      {partial && <HarvestPartialReport partial={partial} />}

      {preflight && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>Confirm harvest</h3>
            <p>
              This copies the worktree's changed files back into your project at its real
              location. A safety snapshot of your project is always taken first.
            </p>

            {preflight.mainlineDirty && (
              <div className="flag-evidence" data-testid="harvest-mainline-dirty">
                Your project has changed on files this harvest would touch. Those changes
                are what the conflicts below are against.
              </div>
            )}

            {preflight.files.length === 0 ? (
              <p className="inspector-meta">No changed files to harvest.</p>
            ) : (
              <table className="harvest-files" data-testid="harvest-files">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preflight.files.map((f) => (
                    <tr key={f.path} data-testid="harvest-file-row">
                      <td>{f.path}</td>
                      <td className={`harvest-status harvest-status-${f.status}`}>
                        {f.status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {preflight.warnings.length > 0 && (
              <ul className="modal-warnings" data-testid="harvest-preflight-warnings">
                {preflight.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            <div className="harvest-controls">
              <label>
                <input
                  type="radio"
                  name="harvest-mode"
                  checked={mode === "apply"}
                  onChange={() => setMode("apply")}
                />
                Apply — write the files into the project
              </label>
              <label>
                <input
                  type="radio"
                  name="harvest-mode"
                  checked={mode === "patch"}
                  onChange={() => setMode("patch")}
                />
                Patch — write a .patch file in the worktree, leave the project untouched
              </label>
              {mode === "apply" && conflictCount > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={allowConflicts}
                    onChange={(e) => setAllowConflicts(e.target.checked)}
                  />
                  Harvest anyway with {conflictCount} conflict(s) — writes conflict markers
                  where it can, and reports the files it could not mark (those are left
                  untouched)
                </label>
              )}
            </div>

            <p className="inspector-meta">
              The worktree is re-read when you confirm, so a change made to it since this
              check will be included.
            </p>

            <div className="modal-actions">
              <button className="modal-cancel" onClick={closeModal}>
                Cancel
              </button>
              <button
                className="modal-confirm"
                onClick={confirmHarvest}
                disabled={confirmBlocked || busy}
              >
                {busy ? "Harvesting…" : "Confirm harvest"}
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="restore-result" data-testid="harvest-result">
          {/* Patch and apply outcomes are structurally different: a successful
              patch run leaves every array empty by design, so reporting counts
              there would read as "nothing happened". Branch on patchPath. */}
          {result.patchPath !== null ? (
            <>
              <div>Patch written (your project was not modified):</div>
              <code data-testid="harvest-patch-path">{result.patchPath}</code>
            </>
          ) : (
            <>
              <div data-testid="harvest-counts">
                {result.applied.length} applied · {result.conflicted.length} conflicted ·{" "}
                {result.skippedIdentical.length} already identical
              </div>
              {result.applied.length > 0 && (
                <ul className="modal-warnings">
                  {result.applied.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {result.conflicted.length > 0 && (
                <>
                  <div style={{ marginTop: 6 }}>
                    Conflicted — see the notes below for which of these carry conflict
                    markers and which were left untouched:
                  </div>
                  <ul className="modal-warnings">
                    {result.conflicted.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
          <div style={{ marginTop: 6 }}>Safety snapshot of your project before harvest:</div>
          <code>{result.safetySnapshotRef}</code>
          {/* Rendered verbatim, always: `conflicted` is actively misleading
              without them, since the marked-up/untouched distinction lives
              ONLY here. */}
          {result.warnings.length > 0 && (
            <ul className="modal-warnings" data-testid="harvest-result-warnings">
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

/**
 * The one thing a user can most easily get wrong about combine, stated in the
 * same words everywhere it appears (preflight modal AND result). Combine emits
 * FILES; it never fabricates a merged conversation. Rendered unconditionally —
 * it is not a warning that can be absent.
 */
const COMBINE_FRESH_SESSION_NOTICE =
  "Files only — no conversation is combined. Sojourn does not synthesize a merged " +
  "transcript, so neither original session is continued: you start a genuinely fresh " +
  "session in the new worktree.";

/** A named list of paths — the result's groups, each rendered distinctly. */
function PathGroup({
  label,
  paths,
  testId,
}: {
  label: string;
  paths: string[];
  testId: string;
}) {
  if (paths.length === 0) return null;
  return (
    <>
      <div className="harvest-partial-label">{label}</div>
      <ul className="modal-warnings" data-testid={testId}>
        {paths.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * Recovery detail for a combine 500 (`write_failed`). NOT a bare error: the
 * worktree exists and holds real merged content, and is deliberately not
 * deleted. Nothing outside it was ever touched — which is why there is no
 * safety snapshot here, unlike harvest's partial report.
 */
function CombinePartialReport({ partial }: { partial: CombinePartialState }) {
  return (
    <div className="harvest-partial" data-testid="combine-partial">
      <strong>Your worktree was partially built — here is exactly what landed, and where.</strong>
      <div>
        Writing stopped part-way. The worktree below was kept on purpose: it holds real
        merged content. Nothing outside it was modified.
      </div>
      <div className="harvest-partial-label">Partially built worktree:</div>
      <code data-testid="combine-partial-worktree">{partial.worktreePath}</code>
      <PathGroup
        label="Merged in before the failure:"
        paths={partial.applied}
        testId="combine-partial-applied"
      />
      <PathGroup
        label="Written with conflict markers:"
        paths={partial.conflicted}
        testId="combine-partial-conflicted"
      />
      <PathGroup
        label="Never processed — these are missing from the worktree:"
        paths={partial.remaining}
        testId="combine-partial-remaining"
      />
    </div>
  );
}

/**
 * Combine: merge the FILE STATES of the inspected node and the marked node
 * into one new worktree.
 *
 * The inspected node is side A and the marked node is side B — which matters
 * twice: the combine node is parented to A (the graph stays a tree; B is
 * recorded as provenance in `meta.mergedFrom`), and on an UNMARKABLE conflict
 * A's content is the one kept verbatim. The modal says so.
 */
function CombineFlow({ nodeA, nodeB }: { nodeA: ChronoNode; nodeB: ChronoNode }) {
  const [preflight, setPreflight] = useState<CombinePreflight | null>(null);
  // The exact PAIR captured when preflight was requested. These — never the
  // live props — are what confirm acts on, so a selection or mark change while
  // the modal is open can't combine a different pair than the one whose file
  // table the user actually reviewed.
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);
  const [result, setResult] = useState<CombineResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<CombinePartialState | null>(null);
  const [allowConflicts, setAllowConflicts] = useState(false);

  function noteError(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
    // Only combine's `write_failed` carries a partial, and only a
    // combine-SHAPED one may be rendered here. Every abort-clean 400
    // (no_common_ancestor, conflicts, cross_project, …) has none — and those
    // provably wrote zero bytes, so there is nothing to recover.
    const p = e instanceof ApiError ? e.partial : null;
    setPartial(p && isCombinePartial(p) ? p : null);
  }

  async function startPreflight() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setPartial(null);
    try {
      const pf = await api.combinePreflight(nodeA.id, nodeB.id);
      setPreflight(pf);
      setPair({ a: nodeA.id, b: nodeB.id });
      setAllowConflicts(false);
    } catch (e) {
      noteError(e);
    } finally {
      setBusy(false);
    }
  }

  function closeModal() {
    setPreflight(null);
    setPair(null);
  }

  async function confirmCombine() {
    if (busy) return;
    if (!pair) return;
    setBusy(true);
    setError(null);
    setPartial(null);
    try {
      const res = await api.combine(pair.a, pair.b, allowConflicts);
      setResult(res);
      closeModal();
    } catch (e) {
      noteError(e);
    } finally {
      setBusy(false);
    }
  }

  const conflicts = preflight?.files.filter((f) => f.status === "conflict") ?? [];
  const unmarkableCount = conflicts.filter((f) => f.unmarkable).length;
  // Mirrors the server's own refusal: combine aborts clean (400 `conflicts`,
  // zero bytes written) when any file conflicts unless allowConflicts is set.
  const confirmBlocked = conflicts.length > 0 && !allowConflicts;

  return (
    <div className="inspector-section" data-testid="combine-flow">
      <h3>Combine</h3>
      <button className="restore-btn" onClick={startPreflight} disabled={busy}>
        {busy ? "Checking…" : "Combine with marked node"}
      </button>
      <div className="inspector-meta" data-testid="combine-partner">
        Marked partner: {nodeB.label ?? nodeB.summary} ({nodeB.id})
      </div>
      {error && (
        <div className="flag-evidence" data-testid="combine-error">
          {error}
        </div>
      )}
      {partial && <CombinePartialReport partial={partial} />}

      {preflight && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>Confirm combine</h3>
            <p>
              This merges the FILE STATES of these two nodes into one new worktree. Neither
              node, session, or your project is modified.
            </p>

            <div className="combine-ids" data-testid="combine-ids">
              <div>
                <strong>A (this node)</strong> — <code>{preflight.nodeIdA}</code>
              </div>
              <div>
                <strong>B (marked node)</strong> — <code>{preflight.nodeIdB}</code>
              </div>
              <div>
                <strong>Merge base</strong> — <code data-testid="combine-base-node">
                  {preflight.baseNodeId}
                </code>
                <span className="inspector-meta">
                  {" "}
                  the nearest common ancestor of A and B; every difference below is measured
                  against it.
                </span>
              </div>
            </div>

            <div className="flag-evidence" data-testid="combine-fresh-session-notice">
              {COMBINE_FRESH_SESSION_NOTICE}
            </div>

            {preflight.files.length === 0 ? (
              <p className="inspector-meta">
                These two nodes have no differing files — combining them would produce a copy
                of A.
              </p>
            ) : (
              <table className="harvest-files" data-testid="combine-files">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preflight.files.map((f) => (
                    <tr key={f.path} data-testid="combine-file-row">
                      <td>{f.path}</td>
                      <td className={`harvest-status harvest-status-${f.status}`}>
                        {f.status}
                        {f.unmarkable ? " (cannot take conflict markers)" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {preflight.warnings.length > 0 && (
              <ul className="modal-warnings" data-testid="combine-preflight-warnings">
                {preflight.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}

            {/* Shown ONLY when there is something to allow. With zero conflicts
                the checkbox would be a meaningless choice, and its absence is
                what tells the user the merge is clean. */}
            {conflicts.length > 0 && (
              <div className="harvest-controls">
                <label>
                  <input
                    type="checkbox"
                    checked={allowConflicts}
                    onChange={(e) => setAllowConflicts(e.target.checked)}
                  />
                  Combine anyway with {conflicts.length} conflict(s) — the worktree is written
                  with conflict markers where it can
                  {unmarkableCount > 0
                    ? `, and ${unmarkableCount} file(s) cannot take markers at all, so A's content is kept as-is there`
                    : ""}
                  .
                </label>
              </div>
            )}

            <div className="modal-actions">
              <button className="modal-cancel" onClick={closeModal}>
                Cancel
              </button>
              <button
                className="modal-confirm"
                onClick={confirmCombine}
                disabled={confirmBlocked || busy}
              >
                {busy ? "Combining…" : "Confirm combine"}
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="restore-result" data-testid="combine-result">
          <div>Combined worktree:</div>
          <code data-testid="combine-worktree">{result.worktreePath}</code>

          {/* Repeated verbatim at the result, where the user is about to go and
              use the worktree — this is the moment they might expect to
              "resume" a merged conversation. There isn't one. */}
          <div className="flag-evidence" data-testid="combine-fresh-session-notice">
            {COMBINE_FRESH_SESSION_NOTICE}
          </div>

          <div className="inspector-meta" data-testid="combine-result-ids">
            A {result.nodeIdA} · B {result.nodeIdB} · base {result.baseNodeId}
          </div>

          <PathGroup
            label="Merged in cleanly from B:"
            paths={result.applied}
            testId="combine-applied"
          />
          {/* `unmarkable` is a SUBSET of `conflicted` — the engine pushes those
              paths into both, because "conflicted" means conflicted, not
              marked. Subtract before rendering: listing a binary conflict under
              "written with conflict markers" would be false (nothing was
              written into it; A's content was kept), and it would appear in
              two groups at once. */}
          <PathGroup
            label="Written with conflict markers — resolve these by hand:"
            paths={result.conflicted.filter((p) => !result.unmarkable.includes(p))}
            testId="combine-conflicted"
          />
          <PathGroup
            label="Could not take conflict markers — A's content kept as-is, B's side is NOT in these files:"
            paths={result.unmarkable}
            testId="combine-unmarkable"
          />
          <PathGroup
            label="Already identical — nothing to do:"
            paths={result.skippedIdentical}
            testId="combine-skipped-identical"
          />

          {/* null is an ordinary outcome, not a failure — so it is simply not
              mentioned rather than reported as a missing value. */}
          {result.combineNodeId !== null && (
            <>
              <div className="harvest-partial-label">Recorded as combine node:</div>
              <code data-testid="combine-node-id">{result.combineNodeId}</code>
            </>
          )}

          {result.warnings.length > 0 && (
            <ul className="modal-warnings" data-testid="combine-result-warnings">
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
  path,
  onSelectNode,
  markedNode,
  onMarkForCombine,
  onClose,
}: InspectorProps & { node: ChronoNode }) {
  // Escape closes the panel — but NEVER out from under an open modal. The
  // restore/harvest/combine modals do not handle Escape themselves (a known
  // deferred a11y item), so without this guard Escape would dismiss the panel
  // behind a modal that stays on screen, stranding the user mid-flow.
  useEffect(() => {
    if (!onClose) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (document.querySelector(".modal-overlay")) return;
      onClose!();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  // Restorability of the "restore to before this node" target — the PARENT.
  // We only have the lineage (`path`, root→here inclusive) to look in; if the
  // parent isn't there (or there is no parent), the value is undefined, which
  // the RestoreFlow reads as unknown-safe (button stays enabled). A root node
  // (no parent) restores to itself, so use its own restorability there.
  const parentNode = node.parentId ? path?.find((p) => p.id === node.parentId) : undefined;
  const beforeTargetRestorable = node.parentId ? parentNode?.restorable : node.restorable;

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
      <div className="inspector-head">
        <h2>{node.label ?? node.kind}</h2>
        {onClose && (
          <button
            type="button"
            className="inspector-close"
            onClick={onClose}
            aria-label="Close inspector"
            title="Close (Esc)"
          >
            ×
          </button>
        )}
      </div>
      <div className="inspector-meta">
        {node.cli} · {node.kind} · {new Date(node.timestamp).toLocaleString()}
      </div>

      <PathSection path={path ?? []} currentId={node.id} onSelectNode={onSelectNode} />

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
            // Gate on the ACTUAL target's restorability: the parent for a
            // "before this node" restore, or the node itself at a root. If the
            // parent isn't in the lineage we were handed, its restorability is
            // unknown → leave enabled (never disable on a missing field).
            restorable={beforeTargetRestorable}
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
        restorable={node.restorable}
        heading="Restore"
        buttonLabel="Restore at this node"
        modalDescription="Restores the working tree to this node's snapshot (or the nearest earlier snapshot if this step didn't take one), into a new worktree."
      />

      {/* Two-step mark-then-combine. Step one is offered whenever this node
          isn't already the marked one; step two appears only once a DIFFERENT
          node is marked (combining a node with itself is a server 400, so it
          is never offered). The mark itself lives in App state. */}
      {onMarkForCombine && markedNode?.id !== node.id && (
        <div className="inspector-section" data-testid="combine-mark-section">
          <h3>Combine</h3>
          <button className="restore-btn" onClick={() => onMarkForCombine(node.id)}>
            Mark for combine
          </button>
          <div className="inspector-meta">
            {markedNode
              ? "Replaces the currently marked node."
              : "Then select another node — in any session — to combine it with."}
          </div>
        </div>
      )}
      {markedNode && markedNode.id !== node.id && (
        <CombineFlow key={`${node.id}|${markedNode.id}`} nodeA={node} nodeB={markedNode} />
      )}
    </div>
  );
}

export function Inspector({
  node,
  onFlagDismissed,
  onAnnotationAdded,
  onFlagsUpdated,
  path,
  onSelectNode,
  markedNode,
  onMarkForCombine,
  onClose,
}: InspectorProps) {
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
      path={path}
      onSelectNode={onSelectNode}
      markedNode={markedNode}
      onMarkForCombine={onMarkForCombine}
      onClose={onClose}
    />
  );
}
