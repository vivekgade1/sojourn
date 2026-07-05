import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram, defaultDeps, type ProgramDeps } from "../src/program.js";
import { projectIdFor } from "@sojourn/core";
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
});
