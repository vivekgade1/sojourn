import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildProgram, defaultDeps, type ProgramDeps } from "../src/program.js";
import { projectIdFor } from "@sojourn/core";
import type { ChronoNode, SessionHealth, StoredFlag } from "@sojourn/core";
import type { Command } from "commander";
import { StubDaemon, closedPort } from "./helpers/stubDaemon.js";

const HONEST_HEADER = "checked: claims vs snapshots recorded by the local Sojourn daemon";

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
function makeNode(partial: Partial<ChronoNode>): ChronoNode {
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

function graphBody(projectId: string, nodes: ChronoNode[]): { status: number; body: unknown } {
  return {
    status: 200,
    body: {
      project: { id: projectId, root: "/repo/x", name: "X", createdAt: "2026-01-01T00:00:00.000Z" },
      sessions: [],
      nodes,
    },
  };
}

describe("soj gate", () => {
  let stub: StubDaemon;

  beforeEach(async () => {
    stub = new StubDaemon();
    await stub.listen();
  });

  afterEach(async () => {
    await stub.close();
  });

  describe("project mode", () => {
    it("clean graph: exits 0 (no exit call), prints honest header + gate passed with turn count", async () => {
      const cwd = "/repo/clean";
      const projectId = projectIdFor(cwd);
      stub.on("GET", `/api/projects/${projectId}/graph`, () =>
        graphBody(projectId, [
          makeNode({ kind: "prompt" }),
          makeNode({ kind: "assistant" }),
          makeNode({ kind: "prompt" }),
          makeNode({ kind: "tool_use" }),
        ]),
      );

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd });
      await run(buildProgram(deps), ["gate"]);

      const text = out.join("\n");
      expect(text).toContain(HONEST_HEADER);
      expect(text).toContain("gate passed: 2 turns, 0 active verified flags");
      expect(exitCodes).toEqual([]);
    });

    it("active verified flag: exits 2 with a table (node id, kind, confidence, evidence excerpt)", async () => {
      const cwd = "/repo/failing";
      const projectId = projectIdFor(cwd);
      stub.on("GET", `/api/projects/${projectId}/graph`, () =>
        graphBody(projectId, [
          makeNode({ kind: "prompt" }),
          makeNode({
            id: "claude:bad",
            flags: [
              makeFlag({
                nodeId: "claude:bad",
                evidence: "claimed edit to packages/core/src/store.ts is absent from the node snapshot",
              }),
            ],
          }),
        ]),
      );

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd });
      await run(buildProgram(deps), ["gate"]);

      const text = out.join("\n");
      expect(text).toContain(HONEST_HEADER);
      expect(text).toContain("gate failed: 1 active verified flag(s)");
      expect(text).toContain("claude:bad");
      expect(text).toContain("edit_claim_mismatch");
      expect(text).toContain("verified");
      expect(text).toContain("high");
      expect(text).toContain("claimed edit to packages/core/src/store.ts");
      expect(exitCodes).toEqual([2]);
    });

    it("dismissed and auto-resolved flags do not gate", async () => {
      const cwd = "/repo/settled";
      const projectId = projectIdFor(cwd);
      stub.on("GET", `/api/projects/${projectId}/graph`, () =>
        graphBody(projectId, [
          makeNode({ kind: "prompt" }),
          makeNode({
            flags: [
              makeFlag({ dismissed: true, evidence: "dismissed" }),
              makeFlag({ autoResolved: true, evidence: "auto-resolved" }),
            ],
          }),
        ]),
      );

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd });
      await run(buildProgram(deps), ["gate"]);

      expect(out.join("\n")).toContain("gate passed: 1 turns, 0 active verified flags");
      expect(exitCodes).toEqual([]);
    });

    it("advisory flags: pass by default (with an honest note), gate with --include-advisory and tier shown as advisory", async () => {
      const cwd = "/repo/advisory";
      const projectId = projectIdFor(cwd);
      stub.on("GET", `/api/projects/${projectId}/graph`, () =>
        graphBody(projectId, [
          makeNode({ kind: "prompt" }),
          makeNode({
            id: "claude:adv",
            flags: [
              makeFlag({
                nodeId: "claude:adv",
                kind: "unstated_assumption",
                tier: "advisory",
                confidence: "medium",
                source: "llm_critic",
                evidence: "Assumed: the default branch is main",
              }),
            ],
          }),
        ]),
      );

      const first = makeDeps({ baseUrl: stub.baseUrl, cwd });
      await run(buildProgram(first.deps), ["gate"]);
      const defaultText = first.out.join("\n");
      expect(defaultText).toContain("gate passed: 1 turns, 0 active verified flags");
      expect(defaultText).toContain("1 active advisory flag(s)");
      expect(defaultText).toContain("--include-advisory");
      expect(first.exitCodes).toEqual([]);

      const second = makeDeps({ baseUrl: stub.baseUrl, cwd });
      await run(buildProgram(second.deps), ["gate", "--include-advisory"]);
      const gatedText = second.out.join("\n");
      expect(gatedText).toContain("gate failed: 0 active verified flag(s) + 1 advisory flag(s) (gated by --include-advisory)");
      expect(gatedText).toContain("claude:adv");
      expect(gatedText).toContain("advisory"); // tier column keeps advisory visually distinct
      expect(second.exitCodes).toEqual([2]);
    });

    it("respects an explicit --project id", async () => {
      stub.on("GET", "/api/projects/explicit-id/graph", () => graphBody("explicit-id", []));
      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd: "/anything" });
      await run(buildProgram(deps), ["gate", "--project", "explicit-id"]);
      expect(stub.requests[0].url).toBe("/api/projects/explicit-id/graph");
      expect(out.join("\n")).toContain("gate passed: 0 turns, 0 active verified flags");
      expect(exitCodes).toEqual([]);
    });
  });

  describe("session mode", () => {
    it("clean session: turns come from the health route, exit 0", async () => {
      const health: SessionHealth = {
        sessionId: "s1",
        turns: 5,
        verifiedActive: 0,
        verifiedResolved: 2,
        advisoryActive: 0,
        dismissed: 1,
        suppressed: 3,
      };
      stub.on("GET", "/api/sessions/s1/health", () => ({ status: 200, body: health }));

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd: "/repo/x" });
      await run(buildProgram(deps), ["gate", "--session", "s1"]);

      const text = out.join("\n");
      expect(stub.requests[0].url).toBe("/api/sessions/s1/health");
      expect(text).toContain(HONEST_HEADER);
      expect(text).toContain("gate passed: 5 turns, 0 active verified flags");
      expect(exitCodes).toEqual([]);
    });

    it("failing session: verdict from health counts, evidence table from the project graph filtered to that session, exit 2", async () => {
      const cwd = "/repo/session-fail";
      const projectId = projectIdFor(cwd);
      const health: SessionHealth = {
        sessionId: "s1",
        turns: 9,
        verifiedActive: 1,
        verifiedResolved: 0,
        advisoryActive: 0,
        dismissed: 0,
        suppressed: 0,
      };
      stub.on("GET", "/api/sessions/s1/health", () => ({ status: 200, body: health }));
      stub.on("GET", `/api/projects/${projectId}/graph`, () =>
        graphBody(projectId, [
          makeNode({
            id: "claude:in-session",
            sessionId: "s1",
            flags: [makeFlag({ nodeId: "claude:in-session", evidence: "in-session evidence" })],
          }),
          makeNode({
            id: "claude:other-session",
            sessionId: "s2",
            flags: [makeFlag({ nodeId: "claude:other-session", evidence: "other-session evidence" })],
          }),
        ]),
      );

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd });
      await run(buildProgram(deps), ["gate", "--session", "s1"]);

      const text = out.join("\n");
      expect(text).toContain("gate failed: 1 active verified flag(s)");
      expect(text).toContain("claude:in-session");
      expect(text).toContain("in-session evidence");
      expect(text).not.toContain("claude:other-session");
      expect(exitCodes).toEqual([2]);
    });

    it("unknown session (404 from health): plain error, exit 1 (distinct from gate-failed=2 and unreachable=3)", async () => {
      stub.on("GET", "/api/sessions/nope/health", () => ({ status: 404, body: { error: "session nope not found" } }));
      const { deps, err, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, cwd: "/repo/x" });
      await run(buildProgram(deps), ["gate", "--session", "nope"]);
      expect(err.join("\n")).toContain("session nope not found");
      expect(exitCodes).toEqual([1]);
    });
  });

  describe("daemon unreachable", () => {
    it("exits 3 (distinct code), still prints the honest header, and never leaks a raw fetch error", async () => {
      const port = await closedPort();
      const { deps, out, err, exitCodes } = makeDeps({
        baseUrl: `http://127.0.0.1:${port}`,
        cwd: "/repo/x",
      });
      await run(buildProgram(deps), ["gate"]);

      expect(out.join("\n")).toContain(HONEST_HEADER);
      const errText = err.join("\n");
      expect(errText).toContain("sojourn daemon is not reachable");
      expect(errText).toContain("soj start");
      expect(errText).not.toContain("fetch failed");
      expect(exitCodes).toEqual([3]);
    });
  });
});
