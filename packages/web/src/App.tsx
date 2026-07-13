import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { GraphCanvas } from "./components/GraphCanvas";
import { Inspector } from "./components/Inspector";
import { JourneyMap } from "./components/JourneyMap";
import { Legend } from "./components/Legend";
import { Toolbar } from "./components/Toolbar";
import { trailOf } from "./layout";
import { searchNodes } from "./search";
import {
  effectiveSessionIds,
  loadSessionSelection,
  saveSessionSelection,
  type SessionOption,
} from "./sessions";
import { isActionable } from "./restore";
import { initTheme, toggleTheme, type Theme } from "./theme";
import { buildJourneys, nodeToTurnIndex } from "./turns";
import type { Annotation, ChronoNode, Project, StoredFlag } from "./types";
import { connectWs } from "./ws";

const LENS_KINDS = new Set<ChronoNode["kind"]>(["decision", "assumption", "checkpoint"]);

function hasActiveFlags(node: ChronoNode): boolean {
  // Auto-resolved flags are settled history, not active signal — they must
  // not keep a node in the flagged-only / lens views.
  return (node.flags ?? []).some((f) => !f.dismissed && !f.autoResolved);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type ViewMode = "map" | "graph";

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<ChronoNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("map");
  const [decisionLens, setDecisionLens] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  // Transient (not persisted): isolate nodes where a restore is provably
  // possible. AND-composes with the other lenses and the session filter.
  const [restorableOnly, setRestorableOnly] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [theme, setTheme] = useState<Theme>(() => initTheme());
  const [focus, setFocus] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 });
  // Daemon-down banner needs BOTH signals: ws disconnected AND a failed HTTP
  // fetch — a socket blip alone must never cry wolf.
  const [fetchFailed, setFetchFailed] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // Stored (user-chosen) session selection; null = default = latest only.
  const [storedSessionIds, setStoredSessionIds] = useState<string[] | null>(null);

  // Kept in sync with selectedProjectId via the effect below so the WS
  // effect (which must have stable [] deps, see below) can always read the
  // *current* selection without reconnecting the socket on project switch.
  const selectedProjectIdRef = useRef(selectedProjectId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  // Refs mirrored for the WS closure (stable [] deps): whether the last fetch
  // failed, and whether the socket has ever been open.
  const fetchFailedRef = useRef(false);
  const everConnectedRef = useRef(false);

  function noteFetchOutcome(failed: boolean) {
    fetchFailedRef.current = failed;
    setFetchFailed(failed);
  }

  useEffect(() => {
    api
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length > 0) setSelectedProjectId(ps[0].id);
        noteFetchOutcome(false);
        setError(null);
      })
      .catch((e) => {
        // App-owned failures surface through the error state (and the daemon
        // banner when the ws agrees) — never through console.error.
        noteFetchOutcome(true);
        setError(errorMessage(e));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    let cancelled = false;
    api
      .getGraph(selectedProjectId)
      .then((res) => {
        if (cancelled) return;
        setNodes(res.nodes);
        noteFetchOutcome(false);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        noteFetchOutcome(true);
        setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  // Session-filter selection is per project: load the stored choice whenever
  // the project changes (null → default latest-only).
  useEffect(() => {
    setStoredSessionIds(selectedProjectId ? loadSessionSelection(selectedProjectId) : null);
  }, [selectedProjectId]);

  // Full re-sync after the daemon comes back: projects + the current graph.
  // Reuses the same api paths as the mount effects; the project-switch effect
  // covers the graph fetch when the selection has to move.
  async function refetchAll() {
    try {
      const ps = await api.listProjects();
      setProjects(ps);
      const currentId = selectedProjectIdRef.current;
      const nextId =
        currentId && ps.some((p) => p.id === currentId) ? currentId : (ps[0]?.id ?? null);
      if (nextId !== currentId) {
        setSelectedProjectId(nextId); // graph effect fetches for the new id
        if (!nextId) setNodes([]);
      } else if (nextId) {
        const res = await api.getGraph(nextId);
        if (selectedProjectIdRef.current === nextId) setNodes(res.nodes);
      }
      noteFetchOutcome(false);
      setError(null);
    } catch (e) {
      noteFetchOutcome(true);
      setError(errorMessage(e));
    }
  }

  useEffect(() => {
    const unsubscribe = connectWs(
      (event) => {
        const currentProjectId = selectedProjectIdRef.current;
        if (event.type === "node_added") {
          if (event.node.projectId !== currentProjectId) return;
          setNodes((prev) => {
            if (prev.some((n) => n.id === event.node.id)) return prev;
            return [...prev, event.node];
          });
        } else if (event.type === "flags_updated") {
          setNodes((prev) =>
            prev.map((n) => (n.id === event.nodeId ? { ...n, flags: event.flags } : n)),
          );
        } else if (event.type === "project_updated") {
          if (event.projectId === currentProjectId && currentProjectId) {
            api
              .getGraph(currentProjectId)
              .then((res) => setNodes(res.nodes))
              .catch(() => {});
          }
        }
      },
      (connected) => {
        setWsConnected(connected);
        if (connected) {
          // Recovered (or first connect after a dead-daemon page load):
          // whatever we're showing may be stale — re-sync. The FIRST clean
          // connect must NOT duplicate the mount fetches.
          const shouldRefetch = everConnectedRef.current || fetchFailedRef.current;
          everConnectedRef.current = true;
          setBannerDismissed(false);
          if (shouldRefetch) void refetchAll();
        } else {
          // Socket closed. One cheap probe tells apart "daemon down" (banner)
          // from a transient socket blip (pill only).
          void api.health().then(
            () => noteFetchOutcome(false),
            () => noteFetchOutcome(true),
          );
        }
      },
    );
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ——— Session filter: journeys/options are built over ALL nodes, then
  // everything downstream (map, graph, search, legend) sees only the selected
  // sessions. Filtering happens BEFORE layout so the perf win is real at
  // scale — hidden sessions are never laid out, not just not painted.
  const allJourneys = useMemo(() => buildJourneys(nodes), [nodes]);

  const sessionOptions: SessionOption[] = useMemo(
    () =>
      allJourneys.map((j) => ({
        sessionId: j.sessionId,
        cli: j.cli,
        startedAt: j.startedAt,
        turnCount: j.turns.length,
        nodeCount: j.nodeCount,
      })),
    [allJourneys],
  );

  const selectedSessionIds = useMemo(
    () =>
      effectiveSessionIds(
        storedSessionIds,
        sessionOptions.map((s) => s.sessionId),
      ),
    [storedSessionIds, sessionOptions],
  );

  const sessionNodes = useMemo(
    () => nodes.filter((n) => selectedSessionIds.has(n.sessionId)),
    [nodes, selectedSessionIds],
  );

  const journeys = useMemo(
    () => allJourneys.filter((j) => selectedSessionIds.has(j.sessionId)),
    [allJourneys, selectedSessionIds],
  );

  function handleSessionSelectionChange(ids: string[]) {
    setStoredSessionIds(ids);
    const projectId = selectedProjectIdRef.current;
    if (projectId) saveSessionSelection(projectId, ids);
  }

  // Graph view REMOVES filtered-out nodes. The map instead keeps every turn
  // and fades the ones without signal (emphasis, not removal) — a journey
  // with missing waypoints wouldn't read as a journey.
  const visibleNodes = useMemo(() => {
    let filtered = sessionNodes;
    if (decisionLens) {
      filtered = filtered.filter((n) => LENS_KINDS.has(n.kind) || hasActiveFlags(n));
    }
    if (flaggedOnly) {
      filtered = filtered.filter((n) => hasActiveFlags(n));
    }
    // Composed LAST, same sequential (AND) style. isActionable treats a missing
    // `restorable` field as EXCLUDED — this filter's whole job is to surface
    // provably-restorable nodes, so absence is "not known restorable" here. The
    // marker views keep their own backward-safe default (see restore.ts).
    if (restorableOnly) {
      filtered = filtered.filter(isActionable);
    }
    return filtered;
  }, [sessionNodes, decisionLens, flaggedOnly, restorableOnly]);

  const turnIndex = useMemo(() => nodeToTurnIndex(journeys), [journeys]);

  const searchActive = searchQuery.trim().length > 0;
  // Search operates WITHIN the selected sessions in both views.
  const searchScope = view === "map" ? sessionNodes : visibleNodes;
  const matchIds = useMemo(
    () => (searchActive ? searchNodes(searchScope, searchQuery) : []),
    [searchScope, searchQuery, searchActive],
  );
  const searchHits = useMemo(
    () => (searchActive ? new Set(matchIds) : null),
    [matchIds, searchActive],
  );
  const matchedTurnIds = useMemo(() => {
    if (!searchActive) return null;
    return new Set(matchIds.map((id) => turnIndex.get(id)).filter((t): t is string => !!t));
  }, [matchIds, turnIndex, searchActive]);

  // In map view, cycle through matched TURNS (deduped, in match order).
  const matchCycle = useMemo(() => {
    if (view === "graph") return matchIds;
    const seen = new Set<string>();
    const turns: string[] = [];
    for (const id of matchIds) {
      const turnId = turnIndex.get(id);
      if (turnId && !seen.has(turnId)) {
        seen.add(turnId);
        turns.push(turnId);
      }
    }
    return turns;
  }, [matchIds, turnIndex, view]);

  // Reset match cursor whenever the query or result set changes.
  useEffect(() => {
    setActiveMatchIndex(matchCycle.length > 0 ? 0 : -1);
    if (matchCycle.length > 0) {
      setFocus((f) => ({ id: matchCycle[0], nonce: f.nonce + 1 }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, matchCycle.join("\n")]);

  function cycleMatch(direction: 1 | -1) {
    if (matchCycle.length === 0) return;
    const next = (activeMatchIndex + direction + matchCycle.length) % matchCycle.length;
    setActiveMatchIndex(next);
    const target = matchCycle[next];
    if (view === "graph") {
      setSelectedNodeId(target);
    } else {
      setSelectedTurnId(target);
    }
    setFocus((f) => ({ id: target, nonce: f.nonce + 1 }));
  }

  function selectAndFocus(id: string) {
    setSelectedNodeId(id);
    const turnId = turnIndex.get(id);
    if (turnId) setSelectedTurnId(turnId);
    setFocus((f) => ({ id: view === "map" ? (turnId ?? null) : id, nonce: f.nonce + 1 }));
  }

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const selectedPath = useMemo(() => {
    if (!selectedNodeId) return [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return trailOf(selectedNodeId, nodes)
      .map((id) => byId.get(id))
      .filter((n): n is ChronoNode => Boolean(n));
  }, [selectedNodeId, nodes]);

  function handleFlagDismissed(nodeId: string, flagId: number) {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId
          ? { ...n, flags: (n.flags ?? []).map((f) => (f.id === flagId ? { ...f, dismissed: true } : f)) }
          : n,
      ),
    );
  }

  function handleFlagsUpdated(nodeId: string, flags: StoredFlag[]) {
    // `flags` is always the node's FULL current flag list (same contract as
    // the WS flags_updated event) — replace, never merge.
    setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, flags } : n)));
  }

  function handleAnnotationAdded(nodeId: string, annotation: Annotation) {
    setNodes((prev) =>
      prev.map((n) =>
        n.id === nodeId ? { ...n, annotations: [...(n.annotations ?? []), annotation] } : n,
      ),
    );
  }

  const showDaemonBanner = !wsConnected && fetchFailed && !bannerDismissed;

  return (
    <div className="app-shell">
      <Toolbar
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={(id) => {
          setSelectedProjectId(id);
          setSelectedTurnId(null);
          setSelectedNodeId(null);
        }}
        view={view}
        onSetView={setView}
        theme={theme}
        onToggleTheme={() => setTheme((t) => toggleTheme(t))}
        decisionLens={decisionLens}
        onToggleDecisionLens={() => setDecisionLens((v) => !v)}
        flaggedOnly={flaggedOnly}
        onToggleFlaggedOnly={() => setFlaggedOnly((v) => !v)}
        restorableOnly={restorableOnly}
        onToggleRestorableOnly={() => setRestorableOnly((v) => !v)}
        wsConnected={wsConnected}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        matchCount={matchCycle.length}
        activeMatchIndex={activeMatchIndex}
        onCycleMatch={cycleMatch}
        sessions={sessionOptions}
        selectedSessionIds={selectedSessionIds}
        onSessionSelectionChange={handleSessionSelectionChange}
      />
      {showDaemonBanner && (
        <div className="daemon-banner" data-testid="daemon-banner" role="alert">
          <span className="daemon-banner-text">
            Sojourn daemon unreachable — start it with <code>soj start</code>, this page will
            recover automatically.
          </span>
          <button
            className="daemon-banner-dismiss"
            aria-label="Dismiss"
            onClick={() => setBannerDismissed(true)}
          >
            ×
          </button>
        </div>
      )}
      <Legend
        nodeCount={sessionNodes.length}
        sessionCount={journeys.length}
        totalSessionCount={allJourneys.length}
        view={view}
        restorableOnly={restorableOnly}
      />
      {error && <div className="inspector-meta" style={{ padding: 8 }}>{error}</div>}
      <div className="app-body">
        {view === "map" ? (
          <JourneyMap
            journeys={journeys}
            selectedTurnId={selectedTurnId}
            onSelectTurn={setSelectedTurnId}
            onSelectNode={setSelectedNodeId}
            selectedNodeId={selectedNodeId}
            matchedTurnIds={matchedTurnIds}
            lenses={{ decision: decisionLens, flagged: flaggedOnly, restorable: restorableOnly }}
            focusTurnId={focus.id}
            focusNonce={focus.nonce}
          />
        ) : (
          <GraphCanvas
            nodes={visibleNodes}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            searchHits={searchHits}
            actionActive={restorableOnly}
            focusNodeId={focus.id}
            focusNonce={focus.nonce}
          />
        )}
        <Inspector
          node={selectedNode}
          onFlagDismissed={handleFlagDismissed}
          onAnnotationAdded={handleAnnotationAdded}
          onFlagsUpdated={handleFlagsUpdated}
          path={selectedPath}
          onSelectNode={selectAndFocus}
        />
      </div>
    </div>
  );
}
