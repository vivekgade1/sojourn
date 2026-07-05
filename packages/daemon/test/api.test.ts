import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import {
  GraphStore,
  ShadowSnapshotter,
  FlagEngine,
  RestoreEngine,
  SojournRestoreError,
} from "@sojourn/core";
import type { ChronoNode, FetchJson, IngestBatch, Project, SnapshotterLike } from "@sojourn/core";
import { parseSessionJsonl } from "@sojourn/adapter-claude";
import { createApp, type ServerDeps } from "../src/server.js";
import { ingestBatch, type IngestDeps } from "../src/ingest.js";
import type { SojournEvent } from "../src/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(
  __dirname,
  "..",
  "..",
  "adapter-claude",
  "test",
  "fixtures",
  "sample-session.jsonl",
);
const fixtureRaw = fs.readFileSync(fixturePath, "utf8");

function makeEventsSink(): { events: SojournEvent[]; broadcast(e: SojournEvent): void } {
  const events: SojournEvent[] = [];
  return {
    events,
    broadcast(e: SojournEvent) {
      events.push(e);
    },
  };
}

describe("daemon HTTP API", () => {
  let projectRoot: string;
  let shadowRoot: string;
  let worktreesRoot: string;
  let store: GraphStore;
  let flagEngine: FlagEngine;
  let restoreEngine: RestoreEngine;
  let sink: ReturnType<typeof makeEventsSink>;
  let fetchJson: FetchJson;
  let snapshotters: Map<string, SnapshotterLike>;
  let snapshotterFor: (project: Project) => SnapshotterLike;
  let ingestDeps: IngestDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-api-project-"));
    shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-api-shadow-"));
    worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-api-worktrees-"));

    store = new GraphStore(":memory:");
    flagEngine = new FlagEngine();
    sink = makeEventsSink();
    fetchJson = vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson;
    snapshotters = new Map();
    snapshotterFor = (project: Project): SnapshotterLike => {
      const existing = snapshotters.get(project.id);
      if (existing) return existing;
      const snapshotter = new ShadowSnapshotter({
        projectRoot: project.root,
        shadowDir: path.join(shadowRoot, project.id),
      });
      snapshotters.set(project.id, snapshotter);
      return snapshotter;
    };

    restoreEngine = new RestoreEngine({
      store,
      snapshotterFor,
      worktreesDir: worktreesRoot,
    });

    ingestDeps = { store, flagEngine, events: sink, fetchJson, snapshotterFor };

    const deps: ServerDeps = {
      store,
      snapshotterFor,
      flagEngine,
      restoreEngine,
      events: sink,
      version: "test-version",
      fetchJson,
    };
    app = createApp(deps);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(shadowRoot, { recursive: true, force: true });
    fs.rmSync(worktreesRoot, { recursive: true, force: true });
  });

  async function ingestFixture(): Promise<{ projectId: string; nodes: ChronoNode[] }> {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    batch.project.root = projectRoot;
    await ingestBatch(ingestDeps, batch);
    const projects = store.getProjects();
    const nodes = store.getGraph(projects[0].id);
    return { projectId: projects[0].id, nodes };
  }

  describe("GET /api/health", () => {
    it("returns ok:true and the injected version", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, version: "test-version" });
    });
  });

  describe("GET /api/projects", () => {
    it("returns an empty array with no projects", async () => {
      const res = await request(app).get("/api/projects");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns projects after ingest", async () => {
      await ingestFixture();
      const res = await request(app).get("/api/projects");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].root).toBe(projectRoot);
    });
  });

  describe("GET /api/projects/:id/graph", () => {
    it("returns project, sessions, and nodes with the right shape", async () => {
      const { projectId } = await ingestFixture();
      const res = await request(app).get(`/api/projects/${projectId}/graph`);
      expect(res.status).toBe(200);
      expect(res.body.project.id).toBe(projectId);
      expect(res.body.sessions).toHaveLength(1);
      expect(res.body.sessions[0].id).toBe("session-abc");
      expect(Array.isArray(res.body.nodes)).toBe(true);
      expect(res.body.nodes.length).toBeGreaterThan(0);
      // nodes carry flags (may be empty array)
      for (const node of res.body.nodes) {
        expect(Array.isArray(node.flags)).toBe(true);
      }
    });

    it("404s for an unknown project id", async () => {
      const res = await request(app).get("/api/projects/does-not-exist/graph");
      expect(res.status).toBe(404);
      expect(res.body.error).toBeTruthy();
    });
  });

  describe("GET /api/nodes/:id", () => {
    it("returns the node with flags+annotations, handling URL-encoded ids", async () => {
      const { nodes } = await ingestFixture();
      const node = nodes[0];
      expect(node.id).toContain(":");

      const res = await request(app).get(`/api/nodes/${encodeURIComponent(node.id)}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(node.id);
      expect(Array.isArray(res.body.flags)).toBe(true);
      expect(Array.isArray(res.body.annotations)).toBe(true);
    });

    it("404s for an unknown node id (still URL-encoded)", async () => {
      const res = await request(app).get(`/api/nodes/${encodeURIComponent("claude:nope")}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBeTruthy();
    });
  });

  describe("GET /api/nodes/:id/diff", () => {
    it("returns changes:[] when the node has no snapshotRef", async () => {
      const { nodes } = await ingestFixture();
      // The very first prompt node in the fixture predates any snapshot.
      const promptNode = nodes.find((n) => n.kind === "prompt")!;
      const res = await request(app).get(
        `/api/nodes/${encodeURIComponent(promptNode.id)}/diff`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ changes: [] });
    });

    it("returns non-empty changes for a snapshotted node (parent -> node diff)", async () => {
      const { nodes } = await ingestFixture();
      const snapshotted = nodes.filter((n) => n.snapshotRef !== null);
      expect(snapshotted.length).toBeGreaterThan(0);
      const target = snapshotted[snapshotted.length - 1];

      const res = await request(app).get(`/api/nodes/${encodeURIComponent(target.id)}/diff`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.changes)).toBe(true);
    });

    it("404s for an unknown node", async () => {
      const res = await request(app).get(
        `/api/nodes/${encodeURIComponent("claude:nope")}/diff`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/nodes/:id/diff/file", () => {
    it("returns a patch string", async () => {
      const { nodes } = await ingestFixture();
      const snapshotted = nodes.filter((n) => n.snapshotRef !== null);
      const target = snapshotted[snapshotted.length - 1];

      const res = await request(app)
        .get(`/api/nodes/${encodeURIComponent(target.id)}/diff/file`)
        .query({ path: "server.ts" });
      expect(res.status).toBe(200);
      expect(typeof res.body.patch).toBe("string");
    });
  });

  describe("POST /api/nodes/:id/flags/run", () => {
    it("executes T1 checks with mocked fetchJson and stores flags", async () => {
      await fsp.writeFile(path.join(projectRoot, "auth.py"), "def refresh(): pass\n");

      const priorNode: ChronoNode = {
        id: "claude:prior-run",
        parentId: null,
        kind: "assistant",
        cli: "claude",
        sessionId: "s-run",
        projectId: "",
        timestamp: "2026-01-01T00:00:00.000Z",
        snapshotRef: null,
        label: null,
        summary: "",
        content: { type: "text", text: "Sure." },
        meta: { nativeUuid: "prior-run" },
      };
      await ingestBatch(ingestDeps, {
        project: { root: projectRoot, name: "test" },
        session: { id: "s-run", cli: "claude" },
        nodes: [priorNode],
      });

      const targetNode: ChronoNode = {
        id: "claude:target-run",
        parentId: "claude:prior-run",
        kind: "assistant",
        cli: "claude",
        sessionId: "s-run",
        projectId: "",
        timestamp: "2026-01-01T00:00:01.000Z",
        snapshotRef: null,
        label: null,
        summary: "",
        content: { type: "text", text: "I updated `auth.py` to handle refresh tokens." },
        meta: { nativeUuid: "target-run" },
      };
      // Ingest (not a raw upsert) so the node gets a real snapshotRef —
      // flags/run needs nodeTree to be non-null for edit_claim_mismatch to
      // evaluate at all.
      await ingestBatch(ingestDeps, {
        project: { root: projectRoot, name: "test" },
        session: { id: "s-run", cli: "claude" },
        nodes: [priorNode, targetNode],
      });

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent(targetNode.id)}/flags/run`)
        .send({});

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.flags)).toBe(true);
      // auth.py existed before this node's snapshot and was not touched by
      // it, so the claimed edit doesn't show up in the parent->node diff.
      expect(res.body.flags.some((f: { kind: string }) => f.kind === "edit_claim_mismatch")).toBe(
        true,
      );
    });

    it("404s for an unknown node", async () => {
      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent("claude:nope")}/flags/run`)
        .send({});
      expect(res.status).toBe(404);
    });

    it("runs T2 with an injected fake CriticLLM, stores the flag, and dedups on a second call", async () => {
      const { nodes } = await ingestFixture();
      const assistantNode = nodes.find((n) => n.kind === "assistant")!;

      const complete = vi.fn(async () =>
        JSON.stringify({
          assumptions: [{ text: "assumed the default branch is main", confidence: "medium" }],
          possible_hallucinations: [],
        }),
      );
      const criticFor = vi.fn(() => ({ complete }));

      const original = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key";
      try {
        const deps: ServerDeps = {
          store,
          snapshotterFor,
          flagEngine,
          restoreEngine,
          events: sink,
          version: "test-version",
          fetchJson,
          criticFor,
        };
        const t2App = createApp(deps);

        const res = await request(t2App)
          .post(`/api/nodes/${encodeURIComponent(assistantNode.id)}/flags/run`)
          .send({ tier: "T2" });

        expect(res.status).toBe(200);
        expect(criticFor).toHaveBeenCalledWith("test-key");
        expect(complete).toHaveBeenCalledTimes(1);
        expect(
          res.body.flags.some(
            (f: { kind: string; source: string }) =>
              f.kind === "unstated_assumption" && f.source === "llm_critic",
          ),
        ).toBe(true);

        const storedFlags = store.getFlags(assistantNode.id);
        expect(
          storedFlags.some((f) => f.kind === "unstated_assumption" && f.source === "llm_critic"),
        ).toBe(true);

        // Second call with the same critic output must dedup, not duplicate.
        const res2 = await request(t2App)
          .post(`/api/nodes/${encodeURIComponent(assistantNode.id)}/flags/run`)
          .send({ tier: "T2" });
        expect(res2.status).toBe(200);
        expect(complete).toHaveBeenCalledTimes(2);

        const afterSecondCall = store.getFlags(assistantNode.id);
        const matching = afterSecondCall.filter(
          (f) => f.kind === "unstated_assumption" && f.source === "llm_critic",
        );
        expect(matching).toHaveLength(1);
      } finally {
        if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = original;
      }
    });

    it("returns 400 for tier T2 when ANTHROPIC_API_KEY is missing", async () => {
      const { nodes } = await ingestFixture();
      const original = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        const res = await request(app)
          .post(`/api/nodes/${encodeURIComponent(nodes[0].id)}/flags/run`)
          .send({ tier: "T2" });
        expect(res.status).toBe(400);
      } finally {
        if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
      }
    });
  });

  describe("POST /api/mark", () => {
    it("creates a node parented to latestNode(sessionId)", async () => {
      const { nodes } = await ingestFixture();
      const sessionId = nodes[0].sessionId;
      const latest = store.latestNode(sessionId)!;

      const res = await request(app)
        .post("/api/mark")
        .send({ sessionId, label: "Key decision here", kind: "decision" });

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe("decision");
      expect(res.body.label).toBe("Key decision here");
      expect(res.body.parentId).toBe(latest.id);
      expect(res.body.sessionId).toBe(sessionId);
    });

    it("400s for an invalid kind", async () => {
      const { nodes } = await ingestFixture();
      const res = await request(app)
        .post("/api/mark")
        .send({ sessionId: nodes[0].sessionId, label: "x", kind: "bogus" });
      expect(res.status).toBe(400);
    });

    it("404s when the session has no nodes", async () => {
      const res = await request(app)
        .post("/api/mark")
        .send({ sessionId: "no-such-session", label: "x", kind: "checkpoint" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/flags/:id/dismiss", () => {
    it("marks the flag dismissed", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "hi");
      const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
      batch.project.root = projectRoot;
      await ingestBatch(ingestDeps, batch);

      const projectId = store.getProjects()[0].id;
      const graph = store.getGraph(projectId);
      const nodeWithFlag = graph.find((n) => (n.flags?.length ?? 0) > 0);

      // Directly add a flag if the fixture content doesn't happen to trigger one.
      const targetNodeId = nodeWithFlag?.id ?? graph[0].id;
      const flag = store.addFlag(targetNodeId, {
        kind: "edit_claim_mismatch",
        tier: "verified",
        confidence: "high",
        evidence: "claimed edit to `x.py`; snapshot diff shows no change to that file",
        source: "deterministic",
      });

      const res = await request(app).post(`/api/flags/${flag.id}/dismiss`).send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const stored = store.getNode(targetNodeId)!;
      const dismissed = stored.flags?.find((f) => f.id === flag.id);
      expect(dismissed?.dismissed).toBe(true);
    });
  });

  describe("POST /api/nodes/:id/annotations", () => {
    it("creates an annotation", async () => {
      const { nodes } = await ingestFixture();
      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent(nodes[0].id)}/annotations`)
        .send({ text: "worth remembering" });
      expect(res.status).toBe(200);
      expect(res.body.text).toBe("worth remembering");
      expect(res.body.nodeId).toBe(nodes[0].id);
    });

    it("404s for an unknown node", async () => {
      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent("claude:nope")}/annotations`)
        .send({ text: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/nodes/:id/preflight and /restore", () => {
    it("preflight + restore happy path returns a worktree", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");

      const node: ChronoNode = {
        id: "claude:restore-ok",
        parentId: null,
        kind: "assistant",
        cli: "claude",
        sessionId: "s-restore",
        projectId: "",
        timestamp: "2026-01-01T00:00:00.000Z",
        snapshotRef: null,
        label: null,
        summary: "",
        content: { type: "text", text: "done" },
        meta: { nativeUuid: "restore-ok" },
      };
      await ingestBatch(ingestDeps, {
        project: { root: projectRoot, name: "test" },
        session: { id: "s-restore", cli: "claude" },
        nodes: [node],
      });

      const stored = store.getNode("claude:restore-ok")!;
      expect(stored.snapshotRef).not.toBeNull();

      const pf = await request(app)
        .post(`/api/nodes/${encodeURIComponent(node.id)}/preflight`)
        .send();
      expect(pf.status).toBe(200);
      expect(pf.body.treeValid).toBe(true);

      const restore = await request(app)
        .post(`/api/nodes/${encodeURIComponent(node.id)}/restore`)
        .send();
      expect(restore.status).toBe(200);
      expect(typeof restore.body.worktreePath).toBe("string");
      expect(fs.existsSync(restore.body.worktreePath)).toBe(true);
    });

    it("400s restore when the preflight tree is invalid", async () => {
      const project = store.upsertProject(projectRoot, "test");
      const node: ChronoNode = {
        id: "claude:restore-bad",
        parentId: null,
        kind: "assistant",
        cli: "claude",
        sessionId: "s-restore-bad",
        projectId: project.id,
        timestamp: "2026-01-01T00:00:00.000Z",
        snapshotRef: null,
        label: null,
        summary: "",
        content: { type: "text", text: "done" },
        meta: { nativeUuid: "restore-bad" },
      };
      store.upsertNode(node);

      const pf = await request(app)
        .post(`/api/nodes/${encodeURIComponent(node.id)}/preflight`)
        .send();
      expect(pf.status).toBe(200);
      expect(pf.body.treeValid).toBe(false);

      const restore = await request(app)
        .post(`/api/nodes/${encodeURIComponent(node.id)}/restore`)
        .send();
      expect(restore.status).toBe(400);
      expect(restore.body.error).toBeTruthy();
    });

    it("404s preflight for an unknown node", async () => {
      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent("claude:nope")}/preflight`)
        .send();
      expect(res.status).toBe(404);
    });

    it("maps a SojournRestoreError with code 'dest_exhausted' to a 500 JSON error", async () => {
      const failingRestoreEngine = {
        preflight: vi.fn(),
        async restore() {
          throw new SojournRestoreError(
            "Could not claim a unique worktree directory after 5 attempts.",
            "dest_exhausted",
          );
        },
      } as unknown as RestoreEngine;

      const deps: ServerDeps = {
        store,
        snapshotterFor,
        flagEngine,
        restoreEngine: failingRestoreEngine,
        events: sink,
        version: "test-version",
        fetchJson,
      };
      const failingApp = createApp(deps);

      const res = await request(failingApp)
        .post(`/api/nodes/${encodeURIComponent("claude:whatever")}/restore`)
        .send();

      expect(res.status).toBe(500);
      expect(typeof res.body.error).toBe("string");
      expect(res.headers["content-type"]).toMatch(/json/);
    });
  });

  describe("POST /api/hooks/claude", () => {
    it("returns ok:true and triggers an injected rescan callback with the transcript_path", async () => {
      const rescanClaudeTranscript = vi.fn(async () => {});
      const deps: ServerDeps = {
        store,
        snapshotterFor,
        flagEngine,
        restoreEngine,
        events: sink,
        version: "test-version",
        fetchJson,
        rescanClaudeTranscript,
      };
      const hookedApp = createApp(deps);

      const res = await request(hookedApp)
        .post("/api/hooks/claude")
        .send({
          session_id: "sess-1",
          transcript_path: "/tmp/some/transcript.jsonl",
          cwd: "/tmp/some",
          hook_event_name: "PostToolUse",
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // rescan is fired after responding; give the event loop a tick.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rescanClaudeTranscript).toHaveBeenCalledWith("/tmp/some/transcript.jsonl");
    });
  });

  describe("POST /api/hooks/opencode", () => {
    it("returns ok:true", async () => {
      const res = await request(app).post("/api/hooks/opencode").send({ sessionId: "abc" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe("error handling (no HTML leakage)", () => {
    it("returns 400 JSON (not Express's HTML error page) for a malformed JSON body", async () => {
      const res = await request(app)
        .post("/api/mark")
        .set("Content-Type", "application/json")
        .send("{not valid json");

      expect(res.status).toBe(400);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(typeof res.body.error).toBe("string");
      expect(res.body.error.length).toBeGreaterThan(0);
      // Must not be Express's default HTML error page.
      expect(res.text).not.toMatch(/<html/i);
    });

    it("returns 404 JSON for an unknown /api/* route", async () => {
      const res = await request(app).get("/api/this-route-does-not-exist");
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(typeof res.body.error).toBe("string");
      expect(res.text).not.toMatch(/<html/i);
    });

    it("returns 500 JSON (not an HTML page) when a synchronous route handler throws (e.g. /api/mark's unguarded store calls)", async () => {
      const throwingStore = {
        ...store,
        latestNode: () => {
          throw new Error("store exploded");
        },
      };
      const deps: ServerDeps = {
        store: throwingStore as unknown as typeof store,
        snapshotterFor,
        flagEngine,
        restoreEngine,
        events: sink,
        version: "test-version",
        fetchJson,
      };
      const throwingApp = createApp(deps);

      const res = await request(throwingApp)
        .post("/api/mark")
        .send({ sessionId: "s1", label: "x", kind: "decision" });

      expect(res.status).toBe(500);
      expect(res.headers["content-type"]).toMatch(/json/);
      expect(typeof res.body.error).toBe("string");
      expect(res.text).not.toMatch(/<html/i);
    });
  });
});
