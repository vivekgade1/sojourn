import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildProgram, defaultDeps, type ProgramDeps } from "../src/program.js";
import { projectIdFor } from "@sojourn/core";
import type { ChronoNode, SearchHit, StoredFlag } from "@sojourn/core";
import type { Command } from "commander";
import { StubDaemon, closedPort } from "./helpers/stubDaemon.js";

function makeDeps(overrides: Partial<ProgramDeps>): {
  deps: ProgramDeps;
  out: string[];
  err: string[];
  exitCodes: number[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];
  const deps = defaultDeps({
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    exit: (code) => {
      exitCodes.push(code);
    },
    ...overrides,
  });
  return { deps, out, err, exitCodes };
}

function run(program: Command, args: string[]): Promise<void> {
  return program.parseAsync(["node", "soj", ...args]);
}

let nodeSeq = 0;
function makeNode(partial: Partial<ChronoNode> & { flags?: StoredFlag[] }): ChronoNode {
  nodeSeq += 1;
  return {
    id: `claude:node-${nodeSeq}`,
    parentId: null,
    kind: "assistant",
    cli: "claude",
    sessionId: "s1",
    projectId: "p1",
    timestamp: "2026-07-01T00:00:00.000Z",
    snapshotRef: null,
    label: null,
    summary: "did a thing",
    content: {},
    meta: { nativeUuid: `node-${nodeSeq}` },
    ...partial,
  };
}

function makeFlag(partial: Partial<StoredFlag>): StoredFlag {
  return {
    id: 1,
    nodeId: "claude:node-1",
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence: "high",
    evidence: "claimed edit not present in snapshot",
    source: "deterministic",
    autoResolved: false,
    dismissed: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...partial,
  };
}

describe("soj why", () => {
  let stub: StubDaemon;

  beforeEach(async () => {
    stub = new StubDaemon();
    await stub.listen();
  });

  afterEach(async () => {
    await stub.close();
  });

  it("GETs /api/search with projectId, q, and file, and prints kind, node id, gist, and snippet in daemon (score) order", async () => {
    const cwd = "/repo/current";
    const projectId = projectIdFor(cwd);
    const hits: SearchHit[] = [
      {
        node: makeNode({
          id: "claude:best",
          kind: "decision",
          label: "chose sqlite over postgres",
          summary: "",
        }),
        score: 12.5,
        snippet: "…we chose [sqlite] because zero-config local-first…",
      },
      {
        node: makeNode({ id: "claude:second", kind: "assistant", summary: "migrated the db layer" }),
        score: 4.2,
        snippet: "…switched db layer to [sqlite]…",
      },
    ];
    stub.on("GET", "/api/search", () => ({ status: 200, body: { hits } }));

    const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd });
    await run(buildProgram(deps), ["why", "why sqlite", "--file", "packages/core/src/store.ts"]);

    expect(stub.requests).toHaveLength(1);
    const url = stub.requests[0].url;
    const params = new URLSearchParams(url.split("?")[1]);
    expect(url.startsWith("/api/search?")).toBe(true);
    expect(params.get("projectId")).toBe(projectId);
    expect(params.get("q")).toBe("why sqlite");
    expect(params.get("file")).toBe("packages/core/src/store.ts");

    const text = out.join("\n");
    expect(text).toContain("[decision] claude:best  chose sqlite over postgres");
    expect(text).toContain("zero-config local-first");
    expect(text).toContain("[assistant] claude:second  migrated the db layer");
    // daemon score order preserved: best hit printed first
    expect(text.indexOf("claude:best")).toBeLessThan(text.indexOf("claude:second"));
    expect(exitCodes).toEqual([]);
  });

  it("respects --project over cwd", async () => {
    stub.on("GET", "/api/search", () => ({ status: 200, body: { hits: [] } }));
    const { deps } = makeDeps({ baseUrl: stub.baseUrl, cwd: "/anything" });
    await run(buildProgram(deps), ["why", "ports", "--project", "explicit-id"]);
    const params = new URLSearchParams(stub.requests[0].url.split("?")[1]);
    expect(params.get("projectId")).toBe("explicit-id");
    expect(params.has("file")).toBe(false);
  });

  it("zero hits: prints a helpful message (no crash, exit 0)", async () => {
    stub.on("GET", "/api/search", () => ({ status: 200, body: { hits: [] } }));
    const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd: "/repo/x" });
    await run(buildProgram(deps), ["why", "quantum blockchain"]);
    const text = out.join("\n");
    expect(text).toContain('no matches for "quantum blockchain"');
    expect(text).toContain("soj decisions");
    expect(exitCodes).toEqual([]);
  });

  it("daemon unreachable: friendly message, exit 1 (standard command behavior)", async () => {
    const port = await closedPort();
    const { deps, err, exitCodes } = makeDeps({ baseUrl: `http://127.0.0.1:${port}`, cwd: "/repo/x" });
    await run(buildProgram(deps), ["why", "anything"]);
    expect(err.join("\n")).toContain("sojourn daemon is not reachable");
    expect(exitCodes).toEqual([1]);
  });
});

describe("soj decisions", () => {
  let stub: StubDaemon;

  beforeEach(async () => {
    stub = new StubDaemon();
    await stub.listen();
  });

  afterEach(async () => {
    await stub.close();
  });

  it("keeps marks (decision/assumption/checkpoint) and actively flagged nodes; drops plain and settled-flag nodes", async () => {
    const hits: SearchHit[] = [
      { node: makeNode({ id: "claude:d1", kind: "decision", label: "use shadow git repo" }), score: 9, snippet: "" },
      { node: makeNode({ id: "claude:a1", kind: "assumption", label: "assume main branch" }), score: 8, snippet: "" },
      { node: makeNode({ id: "claude:c1", kind: "checkpoint", label: "before refactor" }), score: 7, snippet: "" },
      {
        node: makeNode({
          id: "claude:flagged",
          kind: "assistant",
          summary: "claimed a fix",
          flags: [makeFlag({ nodeId: "claude:flagged", evidence: "claimed edit to foo.ts not in snapshot" })],
        }),
        score: 6,
        snippet: "",
      },
      { node: makeNode({ id: "claude:plain", kind: "assistant", summary: "just chatter" }), score: 5, snippet: "" },
      {
        node: makeNode({
          id: "claude:settled",
          kind: "assistant",
          summary: "since-fixed claim",
          flags: [
            makeFlag({ nodeId: "claude:settled", autoResolved: true, evidence: "auto-resolved evidence" }),
            makeFlag({ nodeId: "claude:settled", dismissed: true, evidence: "dismissed evidence" }),
          ],
        }),
        score: 4,
        snippet: "",
      },
    ];
    stub.on("GET", "/api/search", () => ({ status: 200, body: { hits } }));

    const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd: "/repo/current" });
    await run(buildProgram(deps), ["decisions"]);

    const text = out.join("\n");
    expect(text).toContain("[decision] claude:d1  use shadow git repo");
    expect(text).toContain("[assumption] claude:a1  assume main branch");
    expect(text).toContain("[checkpoint] claude:c1  before refactor");
    expect(text).toContain("claude:flagged");
    // flagged surfacing carries the flag evidence, clearly tiered
    expect(text).toContain("edit_claim_mismatch (verified/high)");
    expect(text).toContain("claimed edit to foo.ts not in snapshot");
    // plain assistant node and settled-flags-only node are filtered out
    expect(text).not.toContain("claude:plain");
    expect(text).not.toContain("claude:settled");
    expect(exitCodes).toEqual([]);
  });

  it("sends projectId (and file when given) but no q", async () => {
    const cwd = "/repo/current";
    const projectId = projectIdFor(cwd);
    stub.on("GET", "/api/search", () => ({ status: 200, body: { hits: [] } }));

    const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, cwd });
    await run(buildProgram(deps), ["decisions", "--file", "src/a.ts"]);

    const params = new URLSearchParams(stub.requests[0].url.split("?")[1]);
    expect(params.get("projectId")).toBe(projectId);
    expect(params.get("file")).toBe("src/a.ts");
    expect(params.has("q")).toBe(false);
    expect(out.join("\n")).toContain("no decisions, assumptions, checkpoints, or flagged turns");
  });
});
