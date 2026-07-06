import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { GraphStore, ShadowSnapshotter, FlagEngine, RestoreEngine } from "@sojourn/core";
import type { FetchJson, Project, SnapshotterLike } from "@sojourn/core";
import { createApp, type ServerDeps } from "../src/server.js";
import type { IngestDeps } from "../src/ingest.js";
import { rescanOpenCodeSession, __resetOpenCodeWarnings } from "../src/opencodeIngest.js";
import type { SojournEvent } from "../src/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  __dirname,
  "..",
  "..",
  "adapter-opencode",
  "test",
  "fixtures",
  "sample-messages.json",
);
const fixtureMessages = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as unknown[];

/** Minimal stub OpenCode server: GET /session/:id and GET /session/:id/message. */
function startStubOpenCode(options: {
  sessionId: string;
  directory: string;
  messages: unknown;
}): Promise<{ baseUrl: string; close: () => Promise<void>; requests: string[] }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(`${req.method} ${url}`);
    const encoded = encodeURIComponent(options.sessionId);
    if (req.method === "GET" && url === `/session/${encoded}`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ id: options.sessionId, title: "stub session", directory: options.directory }),
      );
      return;
    }
    if (req.method === "GET" && url === `/session/${encoded}/message`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.messages));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `no stub route for ${req.method} ${url}` }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res2, rej) => server.close((e) => (e ? rej(e) : res2()))),
        requests,
      });
    });
  });
}

describe("OpenCode capture wiring (rescanOpenCodeSession + POST /api/hooks/opencode)", () => {
  let projectRoot: string;
  let shadowRoot: string;
  let store: GraphStore;
  let ingestDeps: IngestDeps;
  let events: SojournEvent[];

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-oc-project-"));
    shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-oc-shadow-"));
    store = new GraphStore(":memory:");
    events = [];
    __resetOpenCodeWarnings();

    const snapshotters = new Map<string, SnapshotterLike>();
    ingestDeps = {
      store,
      flagEngine: new FlagEngine(),
      events: { broadcast: (e: SojournEvent) => events.push(e) },
      fetchJson: vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson,
      snapshotterFor(project: Project): SnapshotterLike {
        const existing = snapshotters.get(project.id);
        if (existing) return existing;
        const snapshotter = new ShadowSnapshotter({
          projectRoot: project.root,
          shadowDir: path.join(shadowRoot, project.id),
        });
        snapshotters.set(project.id, snapshotter);
        return snapshotter;
      },
    };
  });

  afterEach(() => {
    store.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(shadowRoot, { recursive: true, force: true });
  });

  it("POST /api/hooks/opencode pulls the session from a stub OpenCode server and nodes appear in the store", async () => {
    const stub = await startStubOpenCode({
      sessionId: "ses_abc",
      directory: projectRoot,
      messages: fixtureMessages,
    });
    try {
      const deps: ServerDeps = {
        store,
        snapshotterFor: ingestDeps.snapshotterFor,
        flagEngine: ingestDeps.flagEngine,
        restoreEngine: new RestoreEngine({
          store,
          snapshotterFor: ingestDeps.snapshotterFor,
          worktreesDir: path.join(shadowRoot, "worktrees"),
        }),
        events: ingestDeps.events,
        version: "test-version",
        fetchJson: ingestDeps.fetchJson,
        rescanOpenCodeSession: (sessionId: string) =>
          rescanOpenCodeSession(ingestDeps, sessionId, { baseUrl: stub.baseUrl }),
      };
      const app = createApp(deps);

      const res = await request(app).post("/api/hooks/opencode").send({ sessionId: "ses_abc" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // fire-and-forget rescan: wait for the ingest pipeline's terminal
      // event (project_updated is broadcast last) so the background rescan
      // is fully done before we assert (and before afterEach closes the DB).
      await vi.waitFor(() => {
        expect(events.some((e) => e.type === "project_updated")).toBe(true);
      });

      const project = store.getProjects().find((p) => p.root === projectRoot)!;
      const nodes = store.getGraph(project.id);
      // The fixture parses into prompt + assistant/tool nodes (see
      // adapter-opencode parser tests); all must land in the store with
      // opencode ids.
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes.every((n) => n.id.startsWith("opencode:"))).toBe(true);
      expect(nodes.some((n) => n.kind === "prompt")).toBe(true);
      expect(nodes.some((n) => n.kind === "assistant")).toBe(true);

      const sessions = store.getSessions(project.id);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("ses_abc");
      expect(sessions[0].cli).toBe("opencode");

      expect(stub.requests).toContain("GET /session/ses_abc");
      expect(stub.requests).toContain("GET /session/ses_abc/message");
    } finally {
      await stub.close();
    }
  });

  it("rescanOpenCodeSession is idempotent (second pull adds no duplicate nodes)", async () => {
    const stub = await startStubOpenCode({
      sessionId: "ses_abc",
      directory: projectRoot,
      messages: fixtureMessages,
    });
    try {
      await rescanOpenCodeSession(ingestDeps, "ses_abc", { baseUrl: stub.baseUrl });
      const project = store.getProjects().find((p) => p.root === projectRoot)!;
      const countAfterFirst = store.getGraph(project.id).length;
      expect(countAfterFirst).toBeGreaterThan(0);

      await rescanOpenCodeSession(ingestDeps, "ses_abc", { baseUrl: stub.baseUrl });
      expect(store.getGraph(project.id).length).toBe(countAfterFirst);
    } finally {
      await stub.close();
    }
  });

  it("fails soft when the OpenCode server is unreachable: logs once, never throws, ingests nothing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Grab a port that is (almost certainly) connection-refused.
      const probe = http.createServer();
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) =>
        probe.close((e) => (e ? reject(e) : resolve())),
      );
      const deadUrl = `http://127.0.0.1:${port}`;

      await expect(
        rescanOpenCodeSession(ingestDeps, "ses_gone", { baseUrl: deadUrl }),
      ).resolves.toBeUndefined();
      await expect(
        rescanOpenCodeSession(ingestDeps, "ses_gone", { baseUrl: deadUrl }),
      ).resolves.toBeUndefined();

      expect(store.getProjects()).toEqual([]);
      const unreachableLogs = errorSpy.mock.calls.filter((c) =>
        String(c[0]).includes("unreachable"),
      );
      expect(unreachableLogs).toHaveLength(1); // logged once, not per call
    } finally {
      errorSpy.mockRestore();
    }
  });
});
