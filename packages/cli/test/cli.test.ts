import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram, defaultDeps, type ProgramDeps } from "../src/program.js";
import { projectIdFor, GraphStore, ShadowSnapshotter, runGit, type ShadowGitEnv } from "@sojourn/core";
import type { Command } from "commander";

type RouteHandler = (req: IncomingMessage, body: unknown) => { status: number; body: unknown };

/** Minimal stub daemon implementing the routes CLI commands hit. */
class StubServer {
  server: http.Server;
  port = 0;
  requests: Array<{ method: string; url: string; body: unknown }> = [];
  routes = new Map<string, RouteHandler>();

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  key(method: string, pattern: string): string {
    return `${method} ${pattern}`;
  }

  on(method: string, pattern: string, handler: RouteHandler): void {
    this.routes.set(this.key(method, pattern), handler);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    this.requests.push({ method, url, body });

    const pathOnly = url.split("?")[0];
    const handler = this.routes.get(this.key(method, pathOnly));
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no stub route for ${method} ${url}` }));
      return;
    }
    const result = handler(req, body);
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.body === undefined ? "" : JSON.stringify(result.body));
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    if (addr && typeof addr === "object") this.port = addr.port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

function makeDeps(overrides: Partial<ProgramDeps>): { deps: ProgramDeps; out: string[]; err: string[]; exitCodes: number[] } {
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

describe("soj CLI", () => {
  let stub: StubServer;
  let home: string;

  beforeEach(async () => {
    stub = new StubServer();
    await stub.listen();
    home = mkdtempSync(join(tmpdir(), "sojourn-home-"));
  });

  afterEach(async () => {
    await stub.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("projects", () => {
    it("prints a table of projects", async () => {
      stub.on("GET", "/api/projects", () => ({
        status: 200,
        body: [
          { id: "abc123", root: "/repo/a", name: "Repo A", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      }));
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["projects"]);

      expect(stub.requests).toEqual([{ method: "GET", url: "/api/projects", body: undefined }]);
      const text = out.join("\n");
      expect(text).toContain("Repo A");
      expect(text).toContain("/repo/a");
      expect(text).toContain("abc123");
    });

    it("prints a friendly message when there are no projects", async () => {
      stub.on("GET", "/api/projects", () => ({ status: 200, body: [] }));
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["projects"]);
      expect(out.join("\n")).toContain("no projects");
    });
  });

  describe("flags", () => {
    it("hits the project graph route and lists non-dismissed flags with kind/tier/confidence/node/evidence", async () => {
      const cwd = "/repo/current";
      const projectId = projectIdFor(cwd);
      stub.on("GET", `/api/projects/${projectId}/graph`, () => ({
        status: 200,
        body: {
          project: { id: projectId, root: cwd, name: "Current", createdAt: "2026-01-01T00:00:00.000Z" },
          sessions: [],
          nodes: [
            {
              id: "claude:node-1",
              parentId: null,
              kind: "assistant",
              cli: "claude",
              sessionId: "s1",
              projectId,
              timestamp: "2026-01-01T00:00:00.000Z",
              snapshotRef: null,
              label: null,
              summary: "did a thing",
              content: {},
              meta: { nativeUuid: "node-1" },
              flags: [
                {
                  id: 1,
                  nodeId: "claude:node-1",
                  kind: "package_hallucination",
                  tier: "advisory",
                  confidence: "high",
                  evidence: "package left-pad-9000 not found",
                  source: "deterministic",
                  dismissed: false,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
                {
                  id: 2,
                  nodeId: "claude:node-1",
                  kind: "test_claim_unverified",
                  tier: "advisory",
                  confidence: "low",
                  evidence: "dismissed one",
                  source: "deterministic",
                  dismissed: true,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
      }));

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["flags"]);

      expect(stub.requests[0]).toEqual({
        method: "GET",
        url: `/api/projects/${projectId}/graph`,
        body: undefined,
      });
      const text = out.join("\n");
      expect(text).toContain("package_hallucination");
      expect(text).toContain("advisory");
      expect(text).toContain("high");
      expect(text).toContain("claude:node-1");
      expect(text).toContain("package left-pad-9000 not found");
      // dismissed flag must not show up
      expect(text).not.toContain("test_claim_unverified");
    });

    it("hides auto-resolved flags by default and shows them annotated with --all", async () => {
      const cwd = "/repo/current";
      const projectId = projectIdFor(cwd);
      stub.on("GET", `/api/projects/${projectId}/graph`, () => ({
        status: 200,
        body: {
          project: { id: projectId, root: cwd, name: "Current", createdAt: "2026-01-01T00:00:00.000Z" },
          sessions: [],
          nodes: [
            {
              id: "claude:node-2",
              parentId: null,
              kind: "assistant",
              cli: "claude",
              sessionId: "s1",
              projectId,
              timestamp: "2026-01-01T00:00:00.000Z",
              snapshotRef: null,
              label: null,
              summary: "did a thing",
              content: {},
              meta: { nativeUuid: "node-2" },
              flags: [
                {
                  id: 10,
                  nodeId: "claude:node-2",
                  kind: "edit_claim_mismatch",
                  tier: "verified",
                  confidence: "high",
                  evidence: "still active claim",
                  source: "deterministic",
                  autoResolved: false,
                  dismissed: false,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
                {
                  id: 11,
                  nodeId: "claude:node-2",
                  kind: "symbol_not_found",
                  tier: "verified",
                  confidence: "high",
                  evidence: "since-fixed claim",
                  source: "deterministic",
                  autoResolved: true,
                  dismissed: false,
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
              ],
            },
          ],
        },
      }));

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["flags"]);

      const defaultText = out.join("\n");
      expect(defaultText).toContain("still active claim");
      // auto-resolved flag hidden by default
      expect(defaultText).not.toContain("since-fixed claim");
      expect(defaultText).not.toContain("auto-resolved");

      out.length = 0;
      const program2 = buildProgram(deps);
      await run(program2, ["flags", "--all"]);
      const allText = out.join("\n");
      expect(allText).toContain("still active claim");
      expect(allText).toContain("since-fixed claim");
      expect(allText).toContain("symbol_not_found (auto-resolved)");
    });

    it("respects an explicit --project flag over cwd", async () => {
      stub.on("GET", "/api/projects/explicit-id/graph", () => ({
        status: 200,
        body: { project: {}, sessions: [], nodes: [] },
      }));
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd: "/anything" });
      const program = buildProgram(deps);
      await run(program, ["flags", "--project", "explicit-id"]);
      expect(stub.requests[0]?.url).toBe("/api/projects/explicit-id/graph");
      expect(out.join("\n")).toContain("no active flags");
    });
  });

  describe("critic", () => {
    it("POSTs flags/run with tier T2 and prints the advisory flags", async () => {
      stub.on("POST", "/api/nodes/claude%3Anode-1/flags/run", () => ({
        status: 200,
        body: {
          flags: [
            {
              id: 5,
              nodeId: "claude:node-1",
              kind: "unstated_assumption",
              tier: "advisory",
              confidence: "medium",
              evidence: "Assumed: the default branch is main",
              source: "llm_critic",
              autoResolved: false,
              dismissed: false,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: 6,
              nodeId: "claude:node-1",
              kind: "edit_claim_mismatch",
              tier: "verified",
              confidence: "high",
              evidence: "verified flag must not be listed by critic output filter? it is not advisory",
              source: "deterministic",
              autoResolved: false,
              dismissed: false,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      }));

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["critic", "claude:node-1"]);

      const req = stub.requests.find((r) => r.url === "/api/nodes/claude%3Anode-1/flags/run");
      expect(req?.method).toBe("POST");
      expect(req?.body).toEqual({ tier: "T2" });

      const text = out.join("\n");
      expect(text).toContain("unstated_assumption");
      expect(text).toContain("advisory");
      expect(text).toContain("Assumed: the default branch is main");
      // only advisory flags are printed by `soj critic`
      expect(text).not.toContain("edit_claim_mismatch");
      expect(exitCodes).toEqual([]);
    });

    it("prints the daemon's error cleanly (e.g. missing ANTHROPIC_API_KEY) and exits 1", async () => {
      stub.on("POST", "/api/nodes/claude%3Anode-1/flags/run", () => ({
        status: 400,
        body: { error: "T2 requires ANTHROPIC_API_KEY" },
      }));

      const { deps, err, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["critic", "claude:node-1"]);

      expect(err.join("\n")).toContain("T2 requires ANTHROPIC_API_KEY");
      expect(exitCodes).toEqual([1]);
    });
  });

  describe("mark / checkpoint", () => {
    it("resolves the latest session in cwd's project and posts /api/mark with kind decision by default", async () => {
      const cwd = "/repo/current";
      const projectId = projectIdFor(cwd);
      stub.on("GET", `/api/projects/${projectId}/graph`, () => ({
        status: 200,
        body: {
          project: { id: projectId, root: cwd, name: "Current", createdAt: "2026-01-01T00:00:00.000Z" },
          sessions: [
            { id: "s-old", projectId, cli: "claude", title: null, createdAt: "2026-01-01T00:00:00.000Z" },
            { id: "s-new", projectId, cli: "claude", title: null, createdAt: "2026-02-01T00:00:00.000Z" },
          ],
          nodes: [],
        },
      }));
      stub.on("POST", "/api/mark", (_req, body) => ({
        status: 200,
        body: {
          id: "claude:marked-1",
          parentId: null,
          kind: (body as { kind: string }).kind,
          cli: "claude",
          sessionId: (body as { sessionId: string }).sessionId,
          projectId,
          timestamp: "2026-02-02T00:00:00.000Z",
          snapshotRef: null,
          label: (body as { label: string }).label,
          summary: "",
          content: {},
          meta: { nativeUuid: "marked-1" },
        },
      }));

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["mark", "my decision"]);

      const markReq = stub.requests.find((r) => r.method === "POST" && r.url === "/api/mark");
      expect(markReq?.body).toEqual({ sessionId: "s-new", label: "my decision", kind: "decision" });
      expect(out.join("\n")).toContain("claude:marked-1");
    });

    it("checkpoint posts kind checkpoint", async () => {
      const cwd = "/repo/current";
      const projectId = projectIdFor(cwd);
      stub.on("GET", `/api/projects/${projectId}/graph`, () => ({
        status: 200,
        body: {
          project: { id: projectId, root: cwd, name: "Current", createdAt: "2026-01-01T00:00:00.000Z" },
          sessions: [{ id: "s-1", projectId, cli: "claude", title: null, createdAt: "2026-01-01T00:00:00.000Z" }],
          nodes: [],
        },
      }));
      stub.on("POST", "/api/mark", (_req, body) => ({
        status: 200,
        body: {
          id: "claude:cp-1",
          parentId: null,
          kind: (body as { kind: string }).kind,
          cli: "claude",
          sessionId: (body as { sessionId: string }).sessionId,
          projectId,
          timestamp: "2026-02-02T00:00:00.000Z",
          snapshotRef: null,
          label: (body as { label: string }).label,
          summary: "",
          content: {},
          meta: { nativeUuid: "cp-1" },
        },
      }));

      const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["checkpoint", "cp-name"]);

      const markReq = stub.requests.find((r) => r.method === "POST" && r.url === "/api/mark");
      expect(markReq?.body).toEqual({ sessionId: "s-1", label: "cp-name", kind: "checkpoint" });
    });

    it("uses explicit --session over resolved latest", async () => {
      const cwd = "/repo/current";
      stub.on("POST", "/api/mark", (_req, body) => ({
        status: 200,
        body: {
          id: "claude:m2",
          parentId: null,
          kind: (body as { kind: string }).kind,
          cli: "claude",
          sessionId: (body as { sessionId: string }).sessionId,
          projectId: "p",
          timestamp: "2026-02-02T00:00:00.000Z",
          snapshotRef: null,
          label: (body as { label: string }).label,
          summary: "",
          content: {},
          meta: { nativeUuid: "m2" },
        },
      }));
      const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["mark", "assume it works", "--kind", "assumption", "--session", "explicit-session"]);

      const markReq = stub.requests.find((r) => r.method === "POST" && r.url === "/api/mark");
      expect(markReq?.body).toEqual({
        sessionId: "explicit-session",
        label: "assume it works",
        kind: "assumption",
      });
    });
  });

  describe("restore", () => {
    it("without --yes: prints warnings + resume command, does NOT call restore, exits 1", async () => {
      let restoreCalled = false;
      stub.on("POST", "/api/nodes/claude%3Anode-1/preflight", () => ({
        status: 200,
        body: {
          nodeId: "claude:node-1",
          treeHash: "abc",
          treeValid: true,
          warnings: ["uncommitted changes in worktree will be lost", "node_modules will need reinstall"],
          resumeCommand: "claude --resume abc123",
        },
      }));
      stub.on("POST", "/api/nodes/claude%3Anode-1/restore", () => {
        restoreCalled = true;
        return { status: 200, body: { worktreePath: "/x", safetySnapshotRef: "y", resumeCommand: null, warnings: [] } };
      });

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["restore", "claude:node-1"]);

      expect(restoreCalled).toBe(false);
      const text = out.join("\n");
      expect(text).toContain("uncommitted changes in worktree will be lost");
      expect(text).toContain("node_modules will need reinstall");
      expect(text).toContain("claude --resume abc123");
      expect(exitCodes).toEqual([1]);
    });

    it("with --yes: calls preflight route's sibling restore route, prints worktreePath + resumeCommand", async () => {
      stub.on("POST", "/api/nodes/claude%3Anode-1/restore", () => ({
        status: 200,
        body: {
          worktreePath: "/home/.sojourn/worktrees/claude-node-1",
          safetySnapshotRef: "deadbeef",
          resumeCommand: "claude --resume deadbeef",
          warnings: [],
        },
      }));

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["restore", "claude:node-1", "--yes"]);

      const restoreReq = stub.requests.find((r) => r.url === "/api/nodes/claude%3Anode-1/restore");
      expect(restoreReq?.method).toBe("POST");
      const text = out.join("\n");
      expect(text).toContain("/home/.sojourn/worktrees/claude-node-1");
      expect(text).toContain("claude --resume deadbeef");
      expect(exitCodes).toEqual([]);
    });

    it("URL-encodes node ids containing ':' in all restore routes", async () => {
      stub.on("POST", "/api/nodes/opencode%3Aabc-def/preflight", () => ({
        status: 200,
        body: { nodeId: "opencode:abc-def", treeHash: null, treeValid: true, warnings: [], resumeCommand: null },
      }));
      const { deps, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["restore", "opencode:abc-def"]);
      expect(stub.requests[0]?.url).toBe("/api/nodes/opencode%3Aabc-def/preflight");
      expect(exitCodes).toEqual([1]);
    });
  });

  describe("harvest", () => {
    const PREFLIGHT = "/api/worktrees/harvest/preflight";
    const HARVEST = "/api/worktrees/harvest";

    function preflightBody(overrides: Record<string, unknown> = {}) {
      return {
        worktreePath: "/wt",
        originNodeId: "claude:origin-1",
        baseTree: "base",
        branchTree: "branch",
        files: [
          { path: "src/a.ts", status: "identical" },
          { path: "src/b.ts", status: "clean" },
          { path: "src/c.ts", status: "conflict" },
        ],
        mainlineDirty: false,
        warnings: ["the mainline moved since this worktree was restored"],
        ...overrides,
      };
    }

    it("without --yes: prints the preflight table, exits 1, and NEVER calls the apply route", async () => {
      let harvestCalled = false;
      stub.on("POST", PREFLIGHT, () => ({ status: 200, body: preflightBody() }));
      stub.on("POST", HARVEST, () => {
        harvestCalled = true;
        return { status: 200, body: {} };
      });

      const { deps, out, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/harvest-preflight",
      });
      await run(buildProgram(deps), ["harvest", "/wt"]);

      expect(harvestCalled).toBe(false);
      const text = out.join("\n");
      expect(text).toContain("Origin node: claude:origin-1");
      expect(text).toContain("Mainline: clean");
      expect(text).toContain("src/c.ts");
      expect(text).toContain("1 clean, 1 conflict, 1 identical");
      expect(text).toContain("the mainline moved since this worktree was restored");
      expect(text).toContain("Re-run with --yes to confirm the harvest.");
      expect(exitCodes).toEqual([1]);
    });

    it("labels mainlineDirty honestly — 'moved on a path this harvest touches', not 'tree is dirty'", async () => {
      stub.on("POST", PREFLIGHT, () => ({
        status: 200,
        body: preflightBody({ mainlineDirty: true }),
      }));
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd: "/repo/h" });
      await run(buildProgram(deps), ["harvest", "/wt"]);
      expect(out.join("\n")).toContain("Mainline: dirty (moved on a path this harvest touches)");
    });

    it("--yes: posts mode + a literal boolean allowConflicts, prints the applied/skipped summary", async () => {
      stub.on("POST", HARVEST, () => ({
        status: 200,
        body: {
          applied: ["src/b.ts"],
          conflicted: ["src/c.ts"],
          skippedIdentical: ["src/a.ts", "src/d.ts"],
          safetySnapshotRef: "safe-abc",
          patchPath: null,
          mergeNodeId: "claude:merge-1",
          warnings: ["node_modules was not harvested"],
        },
      }));

      const { deps, out, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/harvest-yes",
      });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes", "--allow-conflicts"]);

      const req = stub.requests.find((r) => r.url === HARVEST);
      expect(req?.method).toBe("POST");
      expect(req?.body).toMatchObject({
        worktreePath: "/wt",
        mode: "apply",
        allowConflicts: true,
      });
      // must be a real boolean, not "true" — the daemon tests === true
      expect(typeof (req?.body as { allowConflicts: unknown }).allowConflicts).toBe("boolean");

      const text = out.join("\n");
      expect(text).toContain("Applied (1):");
      expect(text).toContain("  src/b.ts");
      expect(text).toContain("Conflicted (1):");
      expect(text).toContain("Skipped (identical, 2)");
      expect(text).not.toContain("src/d.ts"); // identical files are counted, not listed
      expect(text).toContain("Safety snapshot: safe-abc");
      expect(text).toContain("Merge node: claude:merge-1");
      expect(text).toContain("Warning: node_modules was not harvested");
      expect(exitCodes).toEqual([]);
    });

    it("omits the Merge node line when mergeNodeId is null", async () => {
      stub.on("POST", HARVEST, () => ({
        status: 200,
        body: {
          applied: [],
          conflicted: [],
          skippedIdentical: [],
          safetySnapshotRef: "safe",
          patchPath: null,
          mergeNodeId: null,
          warnings: [],
        },
      }));
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd: "/repo/h" });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes"]);
      expect(out.join("\n")).not.toContain("Merge node:");
    });

    it("--mode patch: prints Patch: and no Applied section", async () => {
      stub.on("POST", HARVEST, () => ({
        status: 200,
        body: {
          applied: [],
          conflicted: [],
          skippedIdentical: [],
          safetySnapshotRef: "safe-patch",
          patchPath: "/tmp/harvest-1.patch",
          mergeNodeId: null,
          warnings: [],
        },
      }));

      const { deps, out, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/harvest-patch",
      });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes", "--mode", "patch"]);

      const req = stub.requests.find((r) => r.url === HARVEST);
      expect((req?.body as { mode: string }).mode).toBe("patch");
      const text = out.join("\n");
      expect(text).toContain("Patch: /tmp/harvest-1.patch");
      expect(text).toContain("Safety snapshot: safe-patch");
      expect(text).not.toContain("Applied");
      expect(text).not.toContain("Skipped");
      expect(exitCodes).toEqual([]);
    });

    it("400 conflicts: prints the error + the re-run hint and exits 1", async () => {
      stub.on("POST", HARVEST, () => ({
        status: 400,
        body: {
          error: "3 file(s) conflict with the mainline",
          code: "conflicts",
          files: ["src/c.ts"],
        },
      }));

      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/harvest-conflict",
      });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes"]);

      const text = err.join("\n");
      expect(text).toContain("error: 3 file(s) conflict with the mainline");
      expect(text).toContain("src/c.ts");
      expect(text).toContain("Re-run with --allow-conflicts to write conflict markers, or --mode patch.");
      expect(exitCodes).toEqual([1]);
    });

    it("400 read_failed: abort-clean error, exits 1, offers no --allow-conflicts hint", async () => {
      stub.on("POST", HARVEST, () => ({
        status: 400,
        body: { error: "could not read src/x.ts", code: "read_failed", files: ["src/x.ts"] },
      }));
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/h",
      });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes"]);
      const text = err.join("\n");
      expect(text).toContain("could not read src/x.ts");
      expect(text).toContain("nothing was written to the mainline");
      expect(text).not.toContain("--allow-conflicts");
      expect(exitCodes).toEqual([1]);
    });

    it("400 with no `code` field (bad worktreePath) still reports cleanly and exits 1", async () => {
      stub.on("POST", HARVEST, () => ({
        status: 400,
        body: { error: "Body must include a string `worktreePath` field" },
      }));
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/h",
      });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes"]);
      expect(err.join("\n")).toContain("Body must include a string `worktreePath` field");
      expect(exitCodes).toEqual([1]);
    });

    it("500 with a `partial` payload: dumps the full partial state to stderr and exits 2", async () => {
      stub.on("POST", HARVEST, () => ({
        status: 500,
        body: {
          error: "harvest failed midway through applying",
          code: "partial_apply",
          files: ["src/b.ts"],
          partial: {
            applied: ["src/a.ts"],
            conflicted: ["src/b.ts"],
            remaining: ["src/c.ts", "src/d.ts"],
            safetySnapshotRef: "safe-partial",
          },
        },
      }));

      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/harvest-partial",
      });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes"]);

      const text = err.join("\n");
      expect(text).toContain("PARTIAL HARVEST");
      expect(text).toContain("applied (1)");
      expect(text).toContain("src/a.ts");
      expect(text).toContain("conflicted (1)");
      expect(text).toContain("remaining (2)");
      expect(text).toContain("src/d.ts");
      expect(text).toContain("safety snapshot: safe-partial");
      // A partially-written mainline is categorically NOT a clean refusal.
      expect(exitCodes).toEqual([2]);
    });

    it("resolves a relative worktreePath against deps.cwd before sending it", async () => {
      stub.on("POST", PREFLIGHT, () => ({ status: 200, body: preflightBody() }));
      const cwd = "/repo/harvest-relative";
      const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      await run(buildProgram(deps), ["harvest", "./sub/wt"]);

      const req = stub.requests.find((r) => r.url === PREFLIGHT);
      expect((req?.body as { worktreePath: string }).worktreePath).toBe(
        join(cwd, "sub", "wt"),
      );
    });

    it("defaults worktreePath to deps.cwd when the positional is omitted", async () => {
      stub.on("POST", PREFLIGHT, () => ({ status: 200, body: preflightBody() }));
      const cwd = "/repo/harvest-default-cwd";
      const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      await run(buildProgram(deps), ["harvest"]);
      const req = stub.requests.find((r) => r.url === PREFLIGHT);
      expect((req?.body as { worktreePath: string }).worktreePath).toBe(cwd);
    });

    it("rejects --allow-conflicts with --mode patch locally, without any HTTP call", async () => {
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/harvest-bad-combo",
      });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes", "--mode", "patch", "--allow-conflicts"]);

      expect(stub.requests).toEqual([]);
      expect(err.join("\n")).toContain("--allow-conflicts applies to --mode apply only");
      expect(exitCodes).toEqual([1]);
    });

    it("rejects an invalid --mode locally, without any HTTP call", async () => {
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/harvest-bad-mode",
      });
      await run(buildProgram(deps), ["harvest", "/wt", "--yes", "--mode", "banana"]);

      expect(stub.requests).toEqual([]);
      expect(err.join("\n")).toContain('--mode must be one of apply|patch (got "banana")');
      expect(exitCodes).toEqual([1]);
    });
  });

  describe("combine", () => {
    const PREFLIGHT = "/api/nodes/combine/preflight";
    const COMBINE = "/api/nodes/combine";
    // combine ALWAYS carries this warning — no transcript is ever synthesized.
    const FRESH_SESSION =
      "no transcript was synthesized — start a fresh session in the combined worktree";

    function preflightBody(overrides: Record<string, unknown> = {}) {
      return {
        nodeIdA: "claude:node-a",
        nodeIdB: "claude:node-b",
        baseNodeId: "claude:node-base",
        baseTree: "basetree",
        treeA: "treeaaa",
        treeB: "treebbb",
        files: [
          { path: "src/a.ts", status: "identical" },
          { path: "src/b.ts", status: "clean" },
          { path: "src/c.ts", status: "conflict" },
          { path: "assets/logo.png", status: "conflict", unmarkable: true },
        ],
        warnings: [FRESH_SESSION],
        ...overrides,
      };
    }

    function resultBody(overrides: Record<string, unknown> = {}) {
      return {
        worktreePath: "/home/.sojourn/worktrees/combine-1",
        nodeIdA: "claude:node-a",
        nodeIdB: "claude:node-b",
        baseNodeId: "claude:node-base",
        baseTree: "basetree",
        treeA: "treeaaa",
        treeB: "treebbb",
        applied: ["src/b.ts"],
        conflicted: ["src/c.ts"],
        unmarkable: ["assets/logo.png"],
        skippedIdentical: ["src/a.ts", "src/d.ts"],
        combineNodeId: "claude:combine-1",
        warnings: [FRESH_SESSION],
        ...overrides,
      };
    }

    it("without --yes: prints ids, base, trees, the table + summary, exits 1, NEVER calls the write route", async () => {
      let combineCalled = false;
      stub.on("POST", PREFLIGHT, () => ({ status: 200, body: preflightBody() }));
      stub.on("POST", COMBINE, () => {
        combineCalled = true;
        return { status: 200, body: resultBody() };
      });

      const { deps, out, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/combine-preflight",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b"]);

      expect(combineCalled).toBe(false);
      // static path, ids in the BODY — no percent-encoded id segments
      const req = stub.requests.find((r) => r.url === PREFLIGHT);
      expect(req?.method).toBe("POST");
      expect(req?.body).toMatchObject({ nodeIdA: "claude:node-a", nodeIdB: "claude:node-b" });

      const text = out.join("\n");
      expect(text).toContain("Node A: claude:node-a");
      expect(text).toContain("Node B: claude:node-b");
      expect(text).toContain("Merge base: claude:node-base");
      expect(text).toContain("basetree");
      expect(text).toContain("treeaaa");
      expect(text).toContain("treebbb");
      expect(text).toContain("src/c.ts");
      expect(text).toContain("1 clean, 2 conflict, 1 identical");
      expect(text).toContain(FRESH_SESSION);
      expect(text).toContain("Re-run with --yes to confirm the combine.");
      expect(exitCodes).toEqual([1]);
    });

    it("preflight sorts conflict rows above clean and identical, and flags unmarkable ones", async () => {
      stub.on("POST", PREFLIGHT, () => ({ status: 200, body: preflightBody() }));
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd: "/repo/c" });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b"]);

      const text = out.join("\n");
      expect(text).toContain("conflict (unmarkable)");
      const lines = out.join("\n").split("\n");
      const idx = (needle: string) => lines.findIndex((l) => l.includes(needle));
      expect(idx("src/c.ts")).toBeLessThan(idx("src/b.ts"));
      expect(idx("src/b.ts")).toBeLessThan(idx("src/a.ts"));
    });

    it("--yes: posts both ids plus a literal boolean allowConflicts", async () => {
      stub.on("POST", COMBINE, () => ({ status: 200, body: resultBody() }));
      const { deps, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/combine-yes",
      });
      await run(buildProgram(deps), [
        "combine",
        "claude:node-a",
        "claude:node-b",
        "--yes",
        "--allow-conflicts",
      ]);

      const req = stub.requests.find((r) => r.url === COMBINE);
      expect(req?.method).toBe("POST");
      expect(req?.body).toMatchObject({
        nodeIdA: "claude:node-a",
        nodeIdB: "claude:node-b",
        allowConflicts: true,
      });
      // must be a real boolean — the daemon tests === true
      expect(typeof (req?.body as { allowConflicts: unknown }).allowConflicts).toBe("boolean");
      expect(exitCodes).toEqual([]);
    });

    it("--yes without --allow-conflicts still sends allowConflicts: false (a boolean, not undefined)", async () => {
      stub.on("POST", COMBINE, () => ({ status: 200, body: resultBody() }));
      const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd: "/repo/c" });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b", "--yes"]);
      const req = stub.requests.find((r) => r.url === COMBINE);
      expect((req?.body as { allowConflicts: unknown }).allowConflicts).toBe(false);
    });

    it("--yes: leads with the worktree path and prints unmarkable SEPARATELY from conflicted", async () => {
      stub.on("POST", COMBINE, () => ({ status: 200, body: resultBody() }));
      const { deps, out, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b", "--yes"]);

      const text = out.join("\n");
      expect(text).toContain("Worktree: /home/.sojourn/worktrees/combine-1");
      expect(text).toContain("Applied (1):");
      expect(text).toContain("  src/b.ts");
      expect(text).toContain("Conflicted — written with conflict markers (1):");
      expect(text).toContain("  src/c.ts");
      // NOT collapsed into "conflicted": these kept A's content verbatim.
      expect(text).toContain(
        "Unmarkable — conflicts that could not take markers, A's content kept (1):",
      );
      expect(text).toContain("  assets/logo.png");
      expect(text).toContain("Skipped (identical, 2)");
      expect(text).toContain("Combine node: claude:combine-1");
      expect(text).toContain(`Warning: ${FRESH_SESSION}`);
      expect(exitCodes).toEqual([]);
    });

    // Regression: `unmarkable` is a SUBSET of `conflicted` — the engine pushes
    // those paths into BOTH arrays (combineEngine.ts: conflicted.push(p);
    // unmarkable.push(p)). Rendering `conflicted` raw listed a binary conflict
    // twice, the first time under "written with conflict markers", which is
    // false for it: nothing was written into that file, A's content was kept.
    // The earlier fixture used DISJOINT arrays, a shape the engine can never
    // produce, so it could not catch this.
    it("does not double-list an unmarkable path (unmarkable ⊆ conflicted)", async () => {
      stub.on("POST", COMBINE, () => ({
        status: 200,
        body: resultBody({
          applied: ["src/b.ts"],
          // The REAL engine shape: the binary path is in both arrays.
          conflicted: ["src/c.ts", "assets/logo.png"],
          unmarkable: ["assets/logo.png"],
        }),
      }));
      const { deps, out, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b", "--yes"]);

      const text = out.join("\n");
      // Only the genuinely MARKED file is counted and listed under markers.
      expect(text).toContain("Conflicted — written with conflict markers (1):");
      expect(text).toContain(
        "Unmarkable — conflicts that could not take markers, A's content kept (1):",
      );
      // The binary path appears exactly once in the whole output.
      const occurrences = text.split("assets/logo.png").length - 1;
      expect(occurrences).toBe(1);
      expect(exitCodes).toEqual([]);
    });

    it("a null combineNodeId is not an error: no 'Combine node' line, still exits 0", async () => {
      stub.on("POST", COMBINE, () => ({
        status: 200,
        body: resultBody({ combineNodeId: null, applied: [], conflicted: [], unmarkable: [] }),
      }));
      const { deps, out, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b", "--yes"]);

      const text = out.join("\n");
      expect(text).not.toContain("Combine node:");
      expect(text).toContain("Worktree:");
      expect(text).toContain(FRESH_SESSION);
      expect(err).toEqual([]);
      expect(exitCodes).toEqual([]);
    });

    it("400 conflicts: prints the error, the files and the --allow-conflicts hint, exits 1", async () => {
      stub.on("POST", COMBINE, () => ({
        status: 400,
        body: {
          error: "2 file(s) conflict between the two nodes",
          code: "conflicts",
          files: ["src/c.ts", "src/e.ts"],
        },
      }));
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b", "--yes"]);

      const text = err.join("\n");
      expect(text).toContain("error: 2 file(s) conflict between the two nodes");
      expect(text).toContain("src/e.ts");
      expect(text).toContain("Re-run with --allow-conflicts to write conflict markers.");
      expect(exitCodes).toEqual([1]);
    });

    it("400 no_common_ancestor: abort-clean, exits 1, no --allow-conflicts hint", async () => {
      stub.on("POST", PREFLIGHT, () => ({
        status: 400,
        body: { error: "no common ancestor", code: "no_common_ancestor", files: [] },
      }));
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b"]);

      const text = err.join("\n");
      expect(text).toContain("no common ancestor");
      expect(text).not.toContain("--allow-conflicts");
      expect(exitCodes).toEqual([1]);
    });

    it("400 with no `code` field reports cleanly and exits 1 (never assume `code` exists)", async () => {
      stub.on("POST", COMBINE, () => ({
        status: 400,
        body: { error: "Body must include a non-empty string `nodeIdB` field" },
      }));
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b", "--yes"]);

      expect(err.join("\n")).toContain("Body must include a non-empty string `nodeIdB` field");
      expect(exitCodes).toEqual([1]);
    });

    it("500 write_failed: dumps the partial state (incl. the surviving worktree) to stderr, exits 2", async () => {
      stub.on("POST", COMBINE, () => ({
        status: 500,
        body: {
          error: "combine failed midway through writing",
          code: "write_failed",
          files: ["src/b.ts"],
          partial: {
            worktreePath: "/home/.sojourn/worktrees/combine-half",
            applied: ["src/a.ts"],
            conflicted: ["src/b.ts"],
            remaining: ["src/c.ts", "src/d.ts"],
          },
        },
      }));
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b", "--yes"]);

      const text = err.join("\n");
      expect(text).toContain("PARTIAL COMBINE");
      // where the half-built worktree lives is the whole point of this dump
      expect(text).toContain("/home/.sojourn/worktrees/combine-half");
      expect(text).toContain("applied (1)");
      expect(text).toContain("src/a.ts");
      expect(text).toContain("conflicted (1)");
      expect(text).toContain("remaining (2)");
      expect(text).toContain("src/d.ts");
      // half-built worktree on disk is categorically NOT a clean refusal
      expect(exitCodes).toEqual([2]);
    });

    it("rejects the same node id twice locally, with zero HTTP calls", async () => {
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-a"]);

      expect(stub.requests).toEqual([]);
      expect(err.join("\n")).toContain("cannot combine a node with itself");
      expect(exitCodes).toEqual([1]);
    });

    it("daemon unreachable: friendly message, exit 1", async () => {
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: "http://127.0.0.1:1",
        sojournHome: home,
        cwd: "/repo/c",
      });
      await run(buildProgram(deps), ["combine", "claude:node-a", "claude:node-b"]);
      expect(err.join("\n")).toContain("sojourn daemon is not reachable");
      expect(exitCodes).toEqual([1]);
    });
  });

  describe("gc", () => {
    /** Builds a real (tiny) shadow repo directly on disk under `home`,
     * exactly where the gc command expects to find it
     * (`<home>/snapshots/<projectId>`), with two snapshots: one far outside
     * any reasonable retention window and one recent. Bypasses
     * ShadowSnapshotter.snapshot() (which always uses "now") to control
     * commit dates via GIT_COMMITTER_DATE/GIT_AUTHOR_DATE, the same way
     * core's gc.test.ts does. Also registers the project in a real
     * sojourn.db under `home` so the CLI command's store lookup succeeds. */
    async function buildShadowRepo(
      sojournHome: string,
      cwd: string,
    ): Promise<{ projectId: string; shadowDir: string; projectRoot: string; oldTree: string; recentTree: string }> {
      const projectId = projectIdFor(cwd);
      const shadowDir = join(sojournHome, "snapshots", projectId);
      const projectRoot = mkdtempSync(join(tmpdir(), "sojourn-gc-cli-project-"));
      const snapshotter = new ShadowSnapshotter({ projectRoot, shadowDir });
      await snapshotter.init();

      const env: ShadowGitEnv = {
        GIT_DIR: shadowDir,
        GIT_WORK_TREE: projectRoot,
        GIT_INDEX_FILE: join(shadowDir, "sojourn-index"),
      };
      const nowSec = Math.floor(Date.now() / 1000);
      const dates = [nowSec - 40 * 86400, nowSec - 1 * 86400];
      const trees: string[] = [];
      let parent: string | null = null;
      for (let i = 0; i < 2; i++) {
        writeFileSync(join(projectRoot, "f.txt"), `v${i}`);
        await runGit(["add", "-A"], env);
        const tree = (await runGit(["write-tree"], env)).trim();
        const commitArgs = ["commit-tree", tree, "-m", `snap-${i}`];
        if (parent) commitArgs.push("-p", parent);
        const commitEnv: ShadowGitEnv = {
          ...env,
          GIT_COMMITTER_DATE: `${dates[i]} +0000`,
          GIT_AUTHOR_DATE: `${dates[i]} +0000`,
        };
        const commit = (await runGit(commitArgs, commitEnv)).trim();
        await runGit(["update-ref", "refs/sojourn/head", commit], env);
        parent = commit;
        trees.push(tree);
      }

      const dbFile = join(sojournHome, "sojourn.db");
      const store = new GraphStore(dbFile);
      store.upsertProject(cwd, "GC Test Project");
      store.close();

      return { projectId, shadowDir, projectRoot, oldTree: trees[0], recentTree: trees[1] };
    }

    it("prints a friendly message and does nothing when there is no sojourn database yet", async () => {
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["gc"]);
      expect(out.join("\n")).toContain("no sojourn database found");
    });

    it("prints a friendly message when the project has no shadow snapshot repo yet", async () => {
      const cwd = "/repo/gc-no-shadow";
      const dbFile = join(home, "sojourn.db");
      const store = new GraphStore(dbFile);
      store.upsertProject(cwd, "No Shadow");
      store.close();

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["gc"]);
      expect(out.join("\n")).toContain("no shadow snapshot repo");
    });

    it("errors on a non-numeric --days and exits 1", async () => {
      const { deps, err, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["gc", "--days", "banana"]);
      expect(err.join("\n")).toContain("--days must be a non-negative integer");
      expect(exitCodes).toEqual([1]);
    });

    it("dry run (default): previews kept/pruned counts + reclaim estimate + a re-run hint, and mutates nothing", async () => {
      const cwd = "/repo/gc-dry-run";
      const { shadowDir, projectRoot, oldTree, recentTree } = await buildShadowRepo(home, cwd);
      const verifyEnv: ShadowGitEnv = {
        GIT_DIR: shadowDir,
        GIT_WORK_TREE: shadowDir,
        GIT_INDEX_FILE: join(shadowDir, "verify-index"),
      };
      const before = (await runGit(["rev-parse", "refs/sojourn/head"], verifyEnv)).trim();

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["gc", "--days", "10"]);

      const text = out.join("\n");
      expect(text).toContain("kept");
      expect(text).toContain("pruned");
      expect(text).toContain("pinned trees: 0");
      expect(text).toMatch(/reclaimable \(estimate\): /);
      expect(text).toContain("dry run only — nothing was deleted. Re-run with --run to execute.");
      expect(exitCodes).toEqual([]);

      const after = (await runGit(["rev-parse", "refs/sojourn/head"], verifyEnv)).trim();
      expect(after).toBe(before);
      const snapshotter = new ShadowSnapshotter({ projectRoot, shadowDir });
      expect(await snapshotter.hasTree(oldTree)).toBe(true);
      expect(await snapshotter.hasTree(recentTree)).toBe(true);
    });

    it("--run actually prunes: the old snapshot's tree becomes unreachable, prints gc complete", async () => {
      const cwd = "/repo/gc-run";
      const { shadowDir, projectRoot, oldTree, recentTree } = await buildShadowRepo(home, cwd);

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["gc", "--days", "10", "--run"]);

      expect(out.join("\n")).toContain("gc complete.");

      // gc keeps a 5-minute grace for young unreachable objects
      // (`gc --prune=5.minutes.ago`, protecting a concurrent writer's fresh
      // objects), and everything in this test is seconds old — so force
      // object-level expiry (test-only; `git gc` never removes reachable
      // objects) to observe that gc genuinely severed the old tree.
      await runGit(["gc", "--prune=now"], {
        GIT_DIR: shadowDir,
        GIT_WORK_TREE: projectRoot,
        GIT_INDEX_FILE: join(shadowDir, "prune-test-index"),
      });

      const snapshotter = new ShadowSnapshotter({ projectRoot, shadowDir });
      expect(await snapshotter.hasTree(oldTree)).toBe(false);
      expect(await snapshotter.hasTree(recentTree)).toBe(true);
    });

    it("--archive-dir writes a backup bundle before pruning and reports its path", async () => {
      const cwd = "/repo/gc-archive";
      await buildShadowRepo(home, cwd);
      const archiveDir = mkdtempSync(join(tmpdir(), "sojourn-gc-cli-archive-"));

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["gc", "--days", "10", "--run", "--archive-dir", archiveDir]);

      const match = out.join("\n").match(/archived pruned history to: (.+\.bundle)/);
      expect(match).not.toBeNull();
      expect(existsSync(match![1])).toBe(true);
      rmSync(archiveDir, { recursive: true, force: true });
    });

    it("respects an explicit --project flag over cwd", async () => {
      const cwd = "/repo/gc-explicit-cwd";
      const explicitCwd = "/repo/gc-explicit-target";
      const { projectId } = await buildShadowRepo(home, explicitCwd);

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["gc", "--project", projectId]);

      expect(out.join("\n")).toContain(projectId);
      expect(exitCodes).toEqual([]);
    });

    it("prints an informational (non-blocking) note when the daemon appears to be running", async () => {
      const cwd = "/repo/gc-daemon-note";
      await buildShadowRepo(home, cwd);
      const { writePid } = await import("../src/daemonCtl.js");
      writePid(home, process.pid); // current test process: definitely alive

      const { deps, out, exitCodes } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["gc"]);

      const text = out.join("\n");
      expect(text).toContain(`daemon is running (pid ${process.pid})`);
      // Pinned wording: gc must NOT claim to be safe concurrently with
      // capture — it aborts safely (CAS on refs/sojourn/head) and asks the
      // user to retry instead.
      expect(text).toContain("gc will abort safely without pruning");
      expect(text).toContain("re-run soj gc later");
      expect(exitCodes).toEqual([]);
    });

    it("protects a tree referenced by a live worktree's .sojourn-restore.json manifest from pruning", async () => {
      const cwd = "/repo/gc-worktree-pin";
      const { projectId, shadowDir, projectRoot, oldTree, recentTree } = await buildShadowRepo(home, cwd);

      const worktreeDir = join(home, "worktrees", projectId, "abc12345-20260101000000");
      mkdirSync(worktreeDir, { recursive: true });
      writeFileSync(
        join(worktreeDir, ".sojourn-restore.json"),
        JSON.stringify(
          {
            nodeId: "claude:x",
            treeHash: oldTree,
            safetySnapshotRef: "deadbeef",
            restoredAt: "2026-01-01T00:00:00.000Z",
            resumeCommand: null,
          },
          null,
          2,
        ),
      );

      const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
      const program = buildProgram(deps);
      await run(program, ["gc", "--days", "10", "--run"]);

      // Force object-level expiry of anything unreachable (test-only;
      // bypasses gc's 5-minute young-object grace) so the survival
      // assertions prove the manifest pin kept the tree REACHABLE, not just
      // physically present.
      await runGit(["gc", "--prune=now"], {
        GIT_DIR: shadowDir,
        GIT_WORK_TREE: projectRoot,
        GIT_INDEX_FILE: join(shadowDir, "prune-test-index"),
      });

      const snapshotter = new ShadowSnapshotter({ projectRoot, shadowDir });
      expect(await snapshotter.hasTree(oldTree)).toBe(true); // protected by the worktree manifest
      expect(await snapshotter.hasTree(recentTree)).toBe(true);
    });

    describe("synthesized transcript sweep", () => {
      let claudeHome: string;
      let projectsSubdir: string;
      let prevConfigDir: string | undefined;

      const AGED_MS = Date.now() - 40 * 86400_000;

      beforeEach(() => {
        claudeHome = mkdtempSync(join(tmpdir(), "sojourn-claude-home-"));
        projectsSubdir = join(claudeHome, "projects", "-repo-encoded");
        mkdirSync(projectsSubdir, { recursive: true });
        prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
        process.env.CLAUDE_CONFIG_DIR = claudeHome;
      });

      afterEach(() => {
        if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
        rmSync(claudeHome, { recursive: true, force: true });
      });

      /** Writes a synthesized transcript + its rewind sidecar, backdated. */
      function writePair(
        sessionId: string,
        sidecar: { originSessionId: string; originNodeId: string; lineUuids: string[] },
        mtimeMs = AGED_MS,
      ): { transcriptPath: string; sidecarPath: string } {
        const transcriptPath = join(projectsSubdir, `${sessionId}.jsonl`);
        const sidecarPath = join(projectsSubdir, `${sessionId}.sojourn-rewind.json`);
        writeFileSync(transcriptPath, `{"uuid":"a"}\n{"uuid":"b"}\n`);
        writeFileSync(sidecarPath, JSON.stringify(sidecar));
        const secs = mtimeMs / 1000;
        utimesSync(transcriptPath, secs, secs);
        utimesSync(sidecarPath, secs, secs);
        return { transcriptPath, sidecarPath };
      }

      /** Registers a session (and optionally a node) for the gc'd project. */
      function seedStore(
        cwd: string,
        sessionId: string,
        node?: { id: string; kind: string },
      ): void {
        const store = new GraphStore(join(home, "sojourn.db"));
        const projectId = projectIdFor(cwd);
        store.upsertSession({ id: sessionId, projectId, cli: "claude" });
        if (node) {
          store.upsertNode({
            id: node.id,
            parentId: null,
            kind: node.kind as never,
            cli: "claude",
            sessionId,
            projectId,
            timestamp: new Date(AGED_MS).toISOString(),
            snapshotRef: null,
            label: "a marked waypoint",
            summary: "",
            content: null,
            meta: { nativeUuid: node.id.split(":")[1] },
          });
        }
        store.close();
      }

      it("dry run (default) deletes nothing and reports the reclaimable transcripts", async () => {
        const cwd = "/repo/gc-sweep-dry";
        await buildShadowRepo(home, cwd);
        seedStore(cwd, "origin-session-1");
        const { transcriptPath, sidecarPath } = writePair("synth-1", {
          originSessionId: "origin-session-1",
          originNodeId: "claude:node-unpinned",
          lineUuids: ["a"],
        });

        const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
        await run(buildProgram(deps), ["gc", "--days", "10"]);

        // dry run must be provably read-only
        expect(existsSync(transcriptPath)).toBe(true);
        expect(existsSync(sidecarPath)).toBe(true);
        const text = out.join("\n");
        expect(text).toContain("transcripts");
        expect(text).toContain("1 pair(s)");
      });

      it("--run deletes an aged synthesized transcript AND its sidecar together", async () => {
        const cwd = "/repo/gc-sweep-run";
        await buildShadowRepo(home, cwd);
        seedStore(cwd, "origin-session-1");
        const { transcriptPath, sidecarPath } = writePair("synth-1", {
          originSessionId: "origin-session-1",
          originNodeId: "claude:node-unpinned",
          lineUuids: ["a"],
        });

        const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
        await run(buildProgram(deps), ["gc", "--days", "10", "--run"]);

        expect(existsSync(sidecarPath)).toBe(false);
        expect(existsSync(transcriptPath)).toBe(false);
        expect(out.join("\n")).toContain("1 pair(s)");
      });

      it("NEVER deletes an orphan_transcript — that is every NATIVE Claude session", async () => {
        const cwd = "/repo/gc-sweep-native";
        await buildShadowRepo(home, cwd);
        seedStore(cwd, "origin-session-1");

        // A native session: a .jsonl with NO sidecar, aged well past the
        // cutoff. Deleting it would destroy real user history.
        const nativePath = join(projectsSubdir, "origin-session-1.jsonl");
        writeFileSync(nativePath, `{"uuid":"real"}\n`);
        utimesSync(nativePath, AGED_MS / 1000, AGED_MS / 1000);

        const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
        await run(buildProgram(deps), ["gc", "--days", "10", "--run"]);

        expect(existsSync(nativePath)).toBe(true);
      });

      it("keeps a pair whose originNodeId is still a live/pinned node in the store", async () => {
        const cwd = "/repo/gc-sweep-pinned";
        await buildShadowRepo(home, cwd);
        seedStore(cwd, "origin-session-1", { id: "claude:node-pinned", kind: "checkpoint" });
        const { transcriptPath, sidecarPath } = writePair("synth-pinned", {
          originSessionId: "origin-session-1",
          originNodeId: "claude:node-pinned",
          lineUuids: ["a"],
        });

        const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
        await run(buildProgram(deps), ["gc", "--days", "10", "--run"]);

        expect(existsSync(transcriptPath)).toBe(true);
        expect(existsSync(sidecarPath)).toBe(true);
      });

      it("keeps a pair that is younger than the keep window", async () => {
        const cwd = "/repo/gc-sweep-young";
        await buildShadowRepo(home, cwd);
        seedStore(cwd, "origin-session-1");
        const { transcriptPath, sidecarPath } = writePair(
          "synth-young",
          {
            originSessionId: "origin-session-1",
            originNodeId: "claude:node-unpinned",
            lineUuids: ["a"],
          },
          Date.now() - 86400_000, // 1 day old
        );

        const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
        await run(buildProgram(deps), ["gc", "--days", "10", "--run"]);

        expect(existsSync(transcriptPath)).toBe(true);
        expect(existsSync(sidecarPath)).toBe(true);
      });

      it("leaves another project's synthesized transcripts alone", async () => {
        const cwd = "/repo/gc-sweep-scoped";
        await buildShadowRepo(home, cwd);
        seedStore(cwd, "origin-session-mine");
        // sidecar points at a session that is NOT in the gc'd project
        const { transcriptPath, sidecarPath } = writePair("synth-other", {
          originSessionId: "origin-session-theirs",
          originNodeId: "claude:node-theirs",
          lineUuids: ["a"],
        });

        const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
        await run(buildProgram(deps), ["gc", "--days", "10", "--run"]);

        expect(existsSync(transcriptPath)).toBe(true);
        expect(existsSync(sidecarPath)).toBe(true);
      });

      it("sweeps an inert orphan_sidecar (residue with no transcript)", async () => {
        const cwd = "/repo/gc-sweep-orphan-sidecar";
        await buildShadowRepo(home, cwd);
        seedStore(cwd, "origin-session-1");
        const sidecarPath = join(projectsSubdir, "synth-orphan.sojourn-rewind.json");
        writeFileSync(
          sidecarPath,
          JSON.stringify({
            originSessionId: "origin-session-1",
            originNodeId: "claude:node-unpinned",
            lineUuids: ["a"],
          }),
        );
        utimesSync(sidecarPath, AGED_MS / 1000, AGED_MS / 1000);

        const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
        await run(buildProgram(deps), ["gc", "--days", "10", "--run"]);

        expect(existsSync(sidecarPath)).toBe(false);
        expect(out.join("\n")).toContain("1 orphan sidecar(s)");
      });

      it("never deletes a pair whose sidecar is malformed (unreadable_sidecar)", async () => {
        const cwd = "/repo/gc-sweep-unreadable";
        await buildShadowRepo(home, cwd);
        seedStore(cwd, "origin-session-1");
        const transcriptPath = join(projectsSubdir, "synth-bad.jsonl");
        const sidecarPath = join(projectsSubdir, "synth-bad.sojourn-rewind.json");
        writeFileSync(transcriptPath, `{"uuid":"a"}\n`);
        writeFileSync(sidecarPath, "{ not json");
        utimesSync(transcriptPath, AGED_MS / 1000, AGED_MS / 1000);
        utimesSync(sidecarPath, AGED_MS / 1000, AGED_MS / 1000);

        const { deps } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, cwd });
        await run(buildProgram(deps), ["gc", "--days", "10", "--run"]);

        expect(existsSync(transcriptPath)).toBe(true);
        expect(existsSync(sidecarPath)).toBe(true);
      });
    });
  });

  describe("open", () => {
    it("does not fail when the opener shim throws (headless environments)", async () => {
      const opened: string[] = [];
      const { deps, out } = makeDeps({
        baseUrl: "http://localhost:4177",
        sojournHome: home,
        openUrl: (url) => {
          opened.push(url);
          throw new Error("simulated headless failure");
        },
      });
      const program = buildProgram(deps);
      await run(program, ["open"]);
      expect(opened).toEqual(["http://localhost:4177"]);
      expect(out.join("\n")).toContain("http://localhost:4177");
    });

    it("prints and opens the base URL", async () => {
      const opened: string[] = [];
      const { deps, out } = makeDeps({
        baseUrl: "http://localhost:4177",
        sojournHome: home,
        openUrl: (url) => opened.push(url),
      });
      const program = buildProgram(deps);
      await run(program, ["open"]);
      expect(opened).toEqual(["http://localhost:4177"]);
      expect(out).toEqual(["http://localhost:4177"]);
    });
  });

  describe("start / stop / status", () => {
    it("start: spawns the daemon, writes a pidfile, polls health, and prints success", async () => {
      stub.on("GET", "/api/health", () => ({ status: 200, body: { ok: true, version: "0.1.0" } }));
      const spawnDaemon = vi.fn().mockReturnValue({ pid: 4242, unref: () => {} });
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, spawnDaemon });
      const program = buildProgram(deps);
      await run(program, ["start"]);

      expect(spawnDaemon).toHaveBeenCalledTimes(1);
      const { readPid } = await import("../src/daemonCtl.js");
      expect(readPid(home)).toBe(4242);
      expect(out.join("\n")).toContain("4242");
    });

    it("start: reports failure and exits 1 when health never becomes ready", async () => {
      // no /api/health route registered -> every poll 404s
      const spawnDaemon = vi.fn().mockReturnValue({ pid: 4343, unref: () => {} });
      const { deps, exitCodes, err } = makeDeps({
        baseUrl: stub.baseUrl,
        sojournHome: home,
        spawnDaemon,
        healthTimeoutMs: 150,
        healthIntervalMs: 20,
      });
      const program = buildProgram(deps);
      await run(program, ["start"]);
      expect(exitCodes).toEqual([1]);
      expect(err.join("\n")).toContain("did not become healthy");
    });

    it("stop: kills the pid from the pidfile and removes it (ESRCH-tolerant)", async () => {
      const { writePid, readPid } = await import("../src/daemonCtl.js");
      writePid(home, 999999); // very unlikely to be a real running pid
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["stop"]);
      expect(readPid(home)).toBeNull();
      expect(out.join("\n")).toMatch(/stopped|not running/);
    });

    it("stop: handles missing pidfile gracefully", async () => {
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["stop"]);
      expect(out.join("\n")).toContain("not running");
    });

    it("status: reports stopped when no pidfile exists", async () => {
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["status"]);
      expect(out.join("\n")).toContain("stopped");
    });

    it("status: reports running + version when pid is alive and health responds", async () => {
      const { writePid } = await import("../src/daemonCtl.js");
      writePid(home, process.pid); // current test process pid is definitely alive
      stub.on("GET", "/api/health", () => ({ status: 200, body: { ok: true, version: "9.9.9" } }));
      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["status"]);
      const text = out.join("\n");
      expect(text).toContain("running");
      expect(text).toContain("9.9.9");
    });
  });

  describe("PID-reuse safety (isDaemonProcess)", () => {
    it("stop: pid alive + command matches the daemon -> signals it and removes the pidfile", async () => {
      const { writePid, readPid } = await import("../src/daemonCtl.js");
      writePid(home, process.pid); // current test process: definitely alive
      const psCommand = vi.fn().mockResolvedValue("/usr/bin/node /home/.sojourn/daemon/dist/main.js\n");
      const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: unknown) => {
        if (pid === process.pid && signal === "SIGTERM") return true;
        return true;
      }) as unknown as typeof process.kill);

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, psCommand });
      const program = buildProgram(deps);
      await run(program, ["stop"]);

      expect(psCommand).toHaveBeenCalledWith(process.pid);
      expect(killSpy).toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(readPid(home)).toBeNull();
      expect(out.join("\n")).toContain("stopped");
      killSpy.mockRestore();
    });

    it("stop: pid alive but command is an unrelated process -> does NOT signal it, removes stale pidfile", async () => {
      const { writePid, readPid } = await import("../src/daemonCtl.js");
      writePid(home, process.pid); // alive, but we'll claim it's not the daemon
      const psCommand = vi.fn().mockResolvedValue("/usr/bin/somethingelse --unrelated-flag\n");
      const killSpy = vi.spyOn(process, "kill");

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, psCommand });
      const program = buildProgram(deps);
      await run(program, ["stop"]);

      expect(psCommand).toHaveBeenCalledWith(process.pid);
      // isPidAlive's liveness probe (kill(pid, 0)) is expected; SIGTERM must not be sent.
      expect(killSpy).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
      expect(readPid(home)).toBeNull();
      const text = out.join("\n");
      expect(text).toContain("not a sojourn daemon");
      expect(text).toContain("stale pidfile");
      killSpy.mockRestore();
    });

    it("start: stale pidfile (pid alive, not a daemon) is removed and a new daemon is started", async () => {
      const { writePid, readPid } = await import("../src/daemonCtl.js");
      writePid(home, process.pid); // alive, but not the daemon per our psCommand shim
      const psCommand = vi.fn().mockResolvedValue("/usr/bin/somethingelse\n");
      stub.on("GET", "/api/health", () => ({ status: 200, body: { ok: true, version: "0.1.0" } }));
      const spawnDaemon = vi.fn().mockReturnValue({ pid: 5555, unref: () => {} });

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, psCommand, spawnDaemon });
      const program = buildProgram(deps);
      await run(program, ["start"]);

      expect(psCommand).toHaveBeenCalledWith(process.pid);
      expect(spawnDaemon).toHaveBeenCalledTimes(1);
      expect(readPid(home)).toBe(5555);
      const text = out.join("\n");
      expect(text).toContain("stale pidfile");
      expect(text).toContain("5555");
    });

    it("start: pid alive + command matches the daemon -> reports already running, does not spawn", async () => {
      const { writePid } = await import("../src/daemonCtl.js");
      writePid(home, process.pid);
      const psCommand = vi.fn().mockResolvedValue("/usr/bin/node /home/.sojourn/daemon/dist/main.js\n");
      const spawnDaemon = vi.fn().mockReturnValue({ pid: 9999, unref: () => {} });

      const { deps, out } = makeDeps({ baseUrl: stub.baseUrl, sojournHome: home, psCommand, spawnDaemon });
      const program = buildProgram(deps);
      await run(program, ["start"]);

      expect(spawnDaemon).not.toHaveBeenCalled();
      expect(out.join("\n")).toContain("already running");
    });
  });

  describe("daemon-unreachable UX", () => {
    async function unreachableDeps(command: string[]): Promise<{ out: string[]; err: string[]; exitCodes: number[] }> {
      // Bind a server just to grab a free port, then close it immediately so
      // the port is (almost certainly) connection-refused for the real test.
      const probe = http.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
      const addr = probe.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));

      const unreachableBaseUrl = `http://127.0.0.1:${port}`;
      const { deps, out, err, exitCodes } = makeDeps({ baseUrl: unreachableBaseUrl, sojournHome: home });
      const program = buildProgram(deps);
      await run(program, command);
      return { out, err, exitCodes };
    }

    it("projects: prints a friendly 'daemon not reachable' message on connection-refused, exits 1", async () => {
      const { err, exitCodes, out } = await unreachableDeps(["projects"]);
      const text = err.join("\n");
      expect(text).toContain("sojourn daemon is not reachable");
      expect(text).toContain("soj start");
      expect(text).not.toContain("fetch failed");
      expect(out.join("\n")).not.toContain("fetch failed");
      expect(exitCodes).toEqual([1]);
    });
  });
});
