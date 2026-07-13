// Shared App-level test harness: a FakeWebSocket standing in for the real
// socket (same shape as ws.test.ts's) plus fixture builders for projects,
// nodes, and whole sessions. Not a test file — vitest only picks *.test.*.
import type { ChronoNode, GraphResponse, NodeKind, Project } from "../src/types";

// jsdom doesn't implement SVGSVGElement#width/height (SVGAnimatedLength),
// which d3-zoom's defaultExtent reads when the map/graph panes mount. Shim
// them so App-level tests can render the real views.
for (const dim of ["width", "height"] as const) {
  if (!Object.getOwnPropertyDescriptor(SVGSVGElement.prototype, dim)) {
    Object.defineProperty(SVGSVGElement.prototype, dim, {
      configurable: true,
      get() {
        return { baseVal: { value: dim === "width" ? 800 : 600 } };
      },
    });
  }
}

type Listener = (evt: unknown) => void;

export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  listeners = new Map<string, Listener[]>();
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, fn: Listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  emit(type: string, evt: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(evt);
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}

export const project: Project = {
  id: "p1",
  root: "/tmp/p1",
  name: "proj-one",
  createdAt: "2026-07-01T00:00:00.000Z",
};

export function makeNode(id: string, overrides: Partial<ChronoNode> = {}): ChronoNode {
  return {
    id,
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: project.id,
    timestamp: "2026-07-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: `node ${id}`,
    content: null,
    flags: [],
    annotations: [],
    meta: { nativeUuid: id },
    ...overrides,
  };
}

/**
 * Builds one session's nodes as a chronological parent chain, one minute
 * apart, starting at `startIso`. Turn count = number of "prompt" kinds.
 */
export function makeSession(
  sessionId: string,
  startIso: string,
  kinds: NodeKind[],
  cli: ChronoNode["cli"] = "claude",
): ChronoNode[] {
  const start = new Date(startIso).getTime();
  return kinds.map((kind, i) =>
    makeNode(`${sessionId}-n${i}`, {
      kind,
      cli,
      sessionId,
      parentId: i === 0 ? null : `${sessionId}-n${i - 1}`,
      timestamp: new Date(start + i * 60_000).toISOString(),
    }),
  );
}

export function graphResponse(nodes: ChronoNode[]): GraphResponse {
  return { project, sessions: [], nodes };
}
