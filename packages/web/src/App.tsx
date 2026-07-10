import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { GraphCanvas } from "./components/GraphCanvas";
import { Inspector } from "./components/Inspector";
import { JourneyMap } from "./components/JourneyMap";
import { Legend } from "./components/Legend";
import { Toolbar } from "./components/Toolbar";
import { trailOf } from "./layout";
import { searchNodes } from "./search";
import { buildJourneys, nodeToTurnIndex } from "./turns";
import type { Annotation, ChronoNode, Project, StoredFlag } from "./types";
import { connectWs } from "./ws";

const LENS_KINDS = new Set<ChronoNode["kind"]>(["decision", "assumption", "checkpoint"]);

function hasActiveFlags(node: ChronoNode): boolean {
  // Auto-resolved flags are settled history, not active signal — they must
  // not keep a node in the flagged-only / lens views.
  return (node.flags ?? []).some((f) => !f.dismissed && !f.autoResolved);
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
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [focus, setFocus] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 });

  // Kept in sync with selectedProjectId via the effect below so the WS
  // effect (which must have stable [] deps, see below) can always read the
  // *current* selection without reconnecting the socket on project switch.
  const selectedProjectIdRef = useRef(selectedProjectId);
  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => {
    api
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        if (ps.length > 0) setSelectedProjectId(ps[0].id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    let cancelled = false;
    api
      .getGraph(selectedProjectId)
      .then((res) => {
        if (!cancelled) setNodes(res.nodes);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  useEffect(() => {
    const unsubscribe = connectWs((event) => {
      const currentProjectId = selectedProjectIdRef.current;
      if (event.type === "node_added") {
        if (event.node.projectId !== currentProjectId) return;
        setNodes((prev) => {
          if (prev.some((n) => n.id === event.node.id)) return prev;
          return [...prev, event.node];
        });
        setWsConnected(true);
      } else if (event.type === "flags_updated") {
        setNodes((prev) =>
          prev.map((n) => (n.id === event.nodeId ? { ...n, flags: event.flags } : n)),
        );
        setWsConnected(true);
      } else if (event.type === "project_updated") {
        if (event.projectId === currentProjectId && currentProjectId) {
          api
            .getGraph(currentProjectId)
            .then((res) => setNodes(res.nodes))
            .catch(() => {});
        }
        setWsConnected(true);
      }
    });
    return unsubscribe;
  }, []);

  // Graph view REMOVES filtered-out nodes. The map instead keeps every turn
  // and fades the ones without signal (emphasis, not removal) — a journey
  // with missing waypoints wouldn't read as a journey.
  const visibleNodes = useMemo(() => {
    let filtered = nodes;
    if (decisionLens) {
      filtered = filtered.filter((n) => LENS_KINDS.has(n.kind) || hasActiveFlags(n));
    }
    if (flaggedOnly) {
      filtered = filtered.filter((n) => hasActiveFlags(n));
    }
    return filtered;
  }, [nodes, decisionLens, flaggedOnly]);

  const journeys = useMemo(() => buildJourneys(nodes), [nodes]);
  const turnIndex = useMemo(() => nodeToTurnIndex(journeys), [journeys]);

  const searchActive = searchQuery.trim().length > 0;
  const searchScope = view === "map" ? nodes : visibleNodes;
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

  const sessionCount = journeys.length;

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
        decisionLens={decisionLens}
        onToggleDecisionLens={() => setDecisionLens((v) => !v)}
        flaggedOnly={flaggedOnly}
        onToggleFlaggedOnly={() => setFlaggedOnly((v) => !v)}
        wsConnected={wsConnected}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        matchCount={matchCycle.length}
        activeMatchIndex={activeMatchIndex}
        onCycleMatch={cycleMatch}
      />
      <Legend nodeCount={nodes.length} sessionCount={sessionCount} view={view} />
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
            emphasizeSignal={decisionLens || flaggedOnly}
            focusTurnId={focus.id}
            focusNonce={focus.nonce}
          />
        ) : (
          <GraphCanvas
            nodes={visibleNodes}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            searchHits={searchHits}
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
