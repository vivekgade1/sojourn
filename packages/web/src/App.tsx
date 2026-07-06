import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { GraphView } from "./components/GraphView";
import { Inspector } from "./components/Inspector";
import { Toolbar } from "./components/Toolbar";
import type { Annotation, ChronoNode, Project, StoredFlag } from "./types";
import { connectWs } from "./ws";

const LENS_KINDS = new Set<ChronoNode["kind"]>(["decision", "assumption", "checkpoint"]);

function hasActiveFlags(node: ChronoNode): boolean {
  // Auto-resolved flags are settled history, not active signal — they must
  // not keep a node in the flagged-only / lens views.
  return (node.flags ?? []).some((f) => !f.dismissed && !f.autoResolved);
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<ChronoNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [decisionLens, setDecisionLens] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

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
        onSelectProject={setSelectedProjectId}
        decisionLens={decisionLens}
        onToggleDecisionLens={() => setDecisionLens((v) => !v)}
        flaggedOnly={flaggedOnly}
        onToggleFlaggedOnly={() => setFlaggedOnly((v) => !v)}
        wsConnected={wsConnected}
      />
      {error && <div className="inspector-meta" style={{ padding: 8 }}>{error}</div>}
      <div className="app-body">
        <GraphView
          nodes={visibleNodes}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
        />
        <Inspector
          node={selectedNode}
          onFlagDismissed={handleFlagDismissed}
          onAnnotationAdded={handleAnnotationAdded}
          onFlagsUpdated={handleFlagsUpdated}
        />
      </div>
    </div>
  );
}
