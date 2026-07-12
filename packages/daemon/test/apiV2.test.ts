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
  SojournHarvestError,
} from "@sojourn/core";
import type {
  ChronoNode,
  FetchJson,
  Flag,
  HarvestPreflight,
  Project,
  SnapshotterLike,
} from "@sojourn/core";
import { parseSessionJsonl } from "@sojourn/adapter-claude";
import { createApp, type ServerDeps } from "../src/server.js";
import { ingestBatch, type IngestDeps } from "../src/ingest.js";
import { TranscriptIndex } from "../src/transcripts.js";
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

/** The fixture's final assistant text node (a clean rewind chain tip). */
const FIXTURE_TIP = "claude:55555555-5555-5555-5555-555555555555";

function makeEventsSink(): { events: SojournEvent[]; broadcast(e: SojournEvent): void } {
  const events: SojournEvent[] = [];
  return {
    events,
    broadcast(e: SojournEvent) {
      events.push(e);
    },
  };
}

function verifiedFlag(evidence: string): Flag {
  return {
    kind: "edit_claim_mismatch",
    tier: "verified",
    confidence: "high",
    evidence,
    source: "deterministic",
  };
}

describe("daemon HTTP API (V2 wiring)", () => {
  let projectRoot: string;
  let shadowRoot: string;
  let worktreesRoot: string;
  let projectsSubdir: string;
  let tempDirs: string[];
  let store: GraphStore;
  let flagEngine: FlagEngine;
  let restoreEngine: RestoreEngine;
  let sink: ReturnType<typeof makeEventsSink>;
  let fetchJson: FetchJson;
  let snapshotters: Map<string, SnapshotterLike>;
  let snapshotterFor: (project: Project) => SnapshotterLike;
  let transcripts: TranscriptIndex;
  let ingestDeps: IngestDeps;
  let baseDeps: ServerDeps;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-apiv2-project-"));
    shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-apiv2-shadow-"));
    worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-apiv2-worktrees-"));
    projectsSubdir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-apiv2-transcripts-"));
    tempDirs = [];

    store = new GraphStore(":memory:");
    flagEngine = new FlagEngine();
    sink = makeEventsSink();
    fetchJson = vi.fn(async () => ({ status: 200, body: {} })) as unknown as FetchJson;
    snapshotters = new Map();
    // Keyed by id::root (mirrors wire.ts): harvest and worktree-aliased flag
    // runs request snapshotters carrying the ORIGIN project's id with a
    // DIFFERENT root — each root gets its own instance while sharing the
    // same shadowDir (keyed by id alone) and therefore one object database.
    snapshotterFor = (project: Project): SnapshotterLike => {
      const key = `${project.id}::${project.root}`;
      const existing = snapshotters.get(key);
      if (existing) return existing;
      const snapshotter = new ShadowSnapshotter({
        projectRoot: project.root,
        shadowDir: path.join(shadowRoot, project.id),
      });
      snapshotters.set(key, snapshotter);
      return snapshotter;
    };
    transcripts = new TranscriptIndex();

    restoreEngine = new RestoreEngine({
      store,
      snapshotterFor,
      worktreesDir: worktreesRoot,
    });

    ingestDeps = { store, flagEngine, events: sink, fetchJson, snapshotterFor, transcripts };

    baseDeps = {
      store,
      snapshotterFor,
      flagEngine,
      restoreEngine,
      events: sink,
      version: "test-version",
      fetchJson,
      transcripts,
    };
    app = createApp(baseDeps);
  });

  afterEach(() => {
    store.close();
    for (const dir of [projectRoot, shadowRoot, worktreesRoot, projectsSubdir, ...tempDirs]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkNode(
    id: string,
    parentId: string | null,
    kind: ChronoNode["kind"],
    sessionId: string,
    timestamp: string,
    content: unknown,
    summary = "",
  ): ChronoNode {
    return {
      id: `claude:${id}`,
      parentId: parentId === null ? null : `claude:${parentId}`,
      kind,
      cli: "claude",
      sessionId,
      projectId: "",
      timestamp,
      snapshotRef: null,
      label: null,
      summary,
      content,
      meta: { nativeUuid: id },
    };
  }

  /** Direct-store two-turn session: prompt->assistant, prompt->assistant. */
  function seedTwoTurnSession(sessionId: string): {
    project: Project;
    turn1Assistant: string;
    turn2Prompt: string;
    turn2Assistant: string;
  } {
    const project = store.upsertProject(projectRoot, "test");
    store.upsertSession({ id: sessionId, projectId: project.id, cli: "claude" });
    const ids = {
      p1: `${sessionId}-p1`,
      a1: `${sessionId}-a1`,
      p2: `${sessionId}-p2`,
      a2: `${sessionId}-a2`,
    };
    const nodes = [
      mkNode(ids.p1, null, "prompt", sessionId, "2026-01-01T00:00:00.000Z", "hi"),
      mkNode(ids.a1, ids.p1, "assistant", sessionId, "2026-01-01T00:00:01.000Z", {
        type: "text",
        text: "turn one",
      }),
      mkNode(ids.p2, ids.a1, "prompt", sessionId, "2026-01-01T00:00:02.000Z", "again"),
      mkNode(ids.a2, ids.p2, "assistant", sessionId, "2026-01-01T00:00:03.000Z", {
        type: "text",
        text: "turn two",
      }),
    ];
    for (const n of nodes) store.upsertNode({ ...n, projectId: project.id });
    return {
      project,
      turn1Assistant: `claude:${ids.a1}`,
      turn2Prompt: `claude:${ids.p2}`,
      turn2Assistant: `claude:${ids.a2}`,
    };
  }

  async function ingestFixture(): Promise<{ projectId: string; nodes: ChronoNode[] }> {
    const batch = parseSessionJsonl(fixturePath, fixtureRaw)!;
    batch.project.root = projectRoot;
    await ingestBatch(ingestDeps, batch);
    const projects = store.getProjects();
    const nodes = store.getGraph(projects[0].id);
    return { projectId: projects[0].id, nodes };
  }

  /** Copies the fixture transcript next to a fake projects subdir and
   * registers it in the transcript index, as the watcher would. */
  async function registerFixtureTranscript(): Promise<string> {
    const transcriptPath = path.join(projectsSubdir, "session-abc.jsonl");
    await fsp.writeFile(transcriptPath, fixtureRaw, "utf8");
    transcripts.record("session-abc", { transcriptPath, diskRoot: projectRoot });
    return transcriptPath;
  }

  describe("GET /api/sessions/:id/health", () => {
    it("404s for an unknown session", async () => {
      const res = await request(app).get("/api/sessions/no-such-session/health");
      expect(res.status).toBe(404);
      expect(res.body.error).toBeTruthy();
    });

    it("returns exact pure counts (verified active/resolved, advisory, dismissed, suppressed, turns)", async () => {
      const { turn2Assistant } = seedTwoTurnSession("s-health");

      // active verified
      store.addFlag(turn2Assistant, verifiedFlag("active claim"));
      // auto-resolved verified
      const resolved = store.addFlag(turn2Assistant, verifiedFlag("resolved claim"));
      store.resolveFlag(resolved.id);
      // dismissed verified
      const dismissed = store.addFlag(turn2Assistant, verifiedFlag("dismissed claim"));
      store.dismissFlag(dismissed.id);
      // advisory active
      store.addFlag(turn2Assistant, {
        kind: "unstated_assumption",
        tier: "advisory",
        confidence: "low",
        evidence: "maybe assumed",
        source: "llm_critic",
      });
      // digest (counts as verified active, carries suppressed rollup)
      store.addFlag(turn2Assistant, {
        ...verifiedFlag("sample …and similar claims suppressed"),
        suppressedCount: 4,
      });

      const res = await request(app).get("/api/sessions/s-health/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sessionId: "s-health",
        turns: 2,
        verifiedActive: 2,
        verifiedResolved: 1,
        advisoryActive: 1,
        dismissed: 1,
        suppressed: 4,
      });
    });
  });

  describe("GET /api/sessions/:id/turn-flags", () => {
    it("404s for an unknown session", async () => {
      const res = await request(app).get("/api/sessions/no-such-session/turn-flags");
      expect(res.status).toBe(404);
    });

    it("defaults to the session's LAST turn when sinceNodeId is absent (the hook omits it)", async () => {
      const { turn1Assistant, turn2Assistant } = seedTwoTurnSession("s-tf");
      store.addFlag(turn1Assistant, verifiedFlag("old-turn claim"));
      store.addFlag(turn2Assistant, verifiedFlag("last-turn claim"));

      const res = await request(app).get("/api/sessions/s-tf/turn-flags");
      expect(res.status).toBe(200);
      expect(res.body.lines).toHaveLength(1);
      expect(res.body.lines[0]).toBe("edit_claim_mismatch: last-turn claim");
    });

    it("includes ONLY active verified flags: advisory, dismissed, and auto-resolved are excluded; digests carry their suppressed count", async () => {
      const { turn2Assistant } = seedTwoTurnSession("s-tf-filter");
      store.addFlag(turn2Assistant, {
        kind: "unstated_assumption",
        tier: "advisory",
        confidence: "low",
        evidence: "advisory noise",
        source: "llm_critic",
      });
      const dismissed = store.addFlag(turn2Assistant, verifiedFlag("dismissed claim"));
      store.dismissFlag(dismissed.id);
      const resolved = store.addFlag(turn2Assistant, verifiedFlag("resolved claim"));
      store.resolveFlag(resolved.id);
      store.addFlag(turn2Assistant, {
        ...verifiedFlag("digest sample …and similar claims suppressed"),
        suppressedCount: 2,
      });

      const res = await request(app).get("/api/sessions/s-tf-filter/turn-flags");
      expect(res.status).toBe(200);
      expect(res.body.lines).toHaveLength(1);
      expect(res.body.lines[0]).toContain("digest sample");
      expect(res.body.lines[0]).toContain("[+2 similar suppressed]");
      expect(res.body.lines.join("\n")).not.toContain("advisory");
    });

    it("caps output at 3 lines plus a '+n more' marker", async () => {
      const { turn2Assistant } = seedTwoTurnSession("s-tf-cap");
      for (let i = 1; i <= 5; i++) {
        store.addFlag(turn2Assistant, verifiedFlag(`claim number ${i}`));
      }

      const res = await request(app).get("/api/sessions/s-tf-cap/turn-flags");
      expect(res.status).toBe(200);
      expect(res.body.lines).toHaveLength(4);
      expect(res.body.lines[3]).toBe("+2 more");
    });

    it("honors an explicit sinceNodeId (flags strictly after that node) and 404s for one not in the session", async () => {
      const { turn1Assistant, turn2Assistant } = seedTwoTurnSession("s-tf-since");
      store.addFlag(turn1Assistant, verifiedFlag("turn-1 claim"));
      store.addFlag(turn2Assistant, verifiedFlag("turn-2 claim"));

      const afterTurn1 = await request(app)
        .get("/api/sessions/s-tf-since/turn-flags")
        .query({ sinceNodeId: turn1Assistant });
      expect(afterTurn1.status).toBe(200);
      expect(afterTurn1.body.lines).toEqual(["edit_claim_mismatch: turn-2 claim"]);

      const afterTip = await request(app)
        .get("/api/sessions/s-tf-since/turn-flags")
        .query({ sinceNodeId: turn2Assistant });
      expect(afterTip.status).toBe(200);
      expect(afterTip.body.lines).toEqual([]);

      const unknown = await request(app)
        .get("/api/sessions/s-tf-since/turn-flags")
        .query({ sinceNodeId: "claude:not-in-session" });
      expect(unknown.status).toBe(404);
    });
  });

  describe("GET /api/search", () => {
    it("400s without projectId", async () => {
      const res = await request(app).get("/api/search").query({ q: "anything" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("projectId");
    });

    it("finds nodes by full-text query, by indexed file, and filtered by kinds CSV", async () => {
      const project = store.upsertProject(projectRoot, "test");
      store.upsertSession({ id: "s-search", projectId: project.id, cli: "claude" });
      const decision = mkNode(
        "se-1",
        null,
        "decision",
        "s-search",
        "2026-01-01T00:00:00.000Z",
        null,
        "decided to use sqlite for the storage layer",
      );
      const prompt = mkNode(
        "se-2",
        "se-1",
        "prompt",
        "s-search",
        "2026-01-01T00:00:01.000Z",
        "hello",
        "hello world greeting",
      );
      store.upsertNode({ ...decision, projectId: project.id });
      store.upsertNode({ ...prompt, projectId: project.id });
      store.indexNodeFiles("claude:se-1", [{ path: "src/auth.py", status: "M" }]);

      const byQuery = await request(app)
        .get("/api/search")
        .query({ projectId: project.id, q: "sqlite" });
      expect(byQuery.status).toBe(200);
      expect(byQuery.body.hits).toHaveLength(1);
      expect(byQuery.body.hits[0].node.id).toBe("claude:se-1");
      expect(typeof byQuery.body.hits[0].score).toBe("number");
      expect(typeof byQuery.body.hits[0].snippet).toBe("string");

      const byFile = await request(app)
        .get("/api/search")
        .query({ projectId: project.id, file: "auth.py" });
      expect(byFile.status).toBe(200);
      expect(byFile.body.hits.map((h: { node: { id: string } }) => h.node.id)).toEqual([
        "claude:se-1",
      ]);

      const byKinds = await request(app)
        .get("/api/search")
        .query({ projectId: project.id, kinds: "prompt,checkpoint" });
      expect(byKinds.status).toBe(200);
      expect(byKinds.body.hits.map((h: { node: { id: string } }) => h.node.id)).toEqual([
        "claude:se-2",
      ]);
    });
  });

  describe("POST /api/nodes/:id/rewind-plan", () => {
    it("returns a pure exact plan for a clean chain — public fields only, no file written", async () => {
      await ingestFixture();
      await registerFixtureTranscript();

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent(FIXTURE_TIP)}/rewind-plan`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("exact");
      expect(res.body.refusedReason).toBeNull();
      expect(typeof res.body.newSessionId).toBe("string");
      expect(res.body.transcriptPath.startsWith(projectsSubdir)).toBe(true);
      expect(res.body.resumeCommand).toBe(`claude --resume ${res.body.newSessionId}`);
      // Internal synthesis fields never leave the daemon.
      expect(res.body.lineIndexes).toBeUndefined();
      expect(res.body.lineUuids).toBeUndefined();
      // Pure: nothing was written.
      expect(fs.existsSync(res.body.transcriptPath)).toBe(false);
    });

    it("400s for a non-claude node", async () => {
      const project = store.upsertProject(projectRoot, "test");
      store.upsertNode({
        id: "opencode:oc-1",
        parentId: null,
        kind: "assistant",
        cli: "opencode",
        sessionId: "s-oc",
        projectId: project.id,
        timestamp: "2026-01-01T00:00:00.000Z",
        snapshotRef: null,
        label: null,
        summary: "",
        content: null,
        meta: { nativeUuid: "oc-1" },
      });

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent("opencode:oc-1")}/rewind-plan`)
        .send();
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("claude nodes only");
    });

    it("404s when the session's transcript is not known to the daemon", async () => {
      await ingestFixture(); // no transcript registered

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent(FIXTURE_TIP)}/rewind-plan`)
        .send();
      expect(res.status).toBe(404);
      expect(res.body.error).toContain("transcript");
    });

    it("404s for an unknown node", async () => {
      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent("claude:nope")}/rewind-plan`)
        .send();
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/nodes/:id/rewind", () => {
    it("re-plans server-side (client body ignored), writes the synthesized transcript, and never touches the original", async () => {
      await ingestFixture();
      const originalPath = await registerFixtureTranscript();

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent(FIXTURE_TIP)}/rewind`)
        // A hostile/bogus "plan" body: must be ignored entirely.
        .send({ mode: "exact", transcriptPath: "/tmp/evil.jsonl", lineIndexes: [999] });

      expect(res.status).toBe(200);
      expect(res.body.mode).toBe("exact");
      expect(res.body.transcriptPath.startsWith(projectsSubdir)).toBe(true);
      expect(res.body.transcriptPath).not.toBe("/tmp/evil.jsonl");

      // The synthesized transcript exists, parses, and carries the NEW id.
      expect(fs.existsSync(res.body.transcriptPath)).toBe(true);
      const written = fs.readFileSync(res.body.transcriptPath, "utf8");
      const batch = parseSessionJsonl(res.body.transcriptPath, written)!;
      expect(batch.session.id).toBe(res.body.newSessionId);

      // The ORIGINAL transcript is byte-identical.
      expect(fs.readFileSync(originalPath, "utf8")).toBe(fixtureRaw);
    });

    it("400s for a non-claude node and 404s without a known transcript", async () => {
      const { nodes } = await ingestFixture();
      const claudeNode = nodes[0];

      const noTranscript = await request(app)
        .post(`/api/nodes/${encodeURIComponent(claudeNode.id)}/rewind`)
        .send();
      expect(noTranscript.status).toBe(404);

      const project = store.getProjects()[0];
      store.upsertNode({
        id: "opencode:oc-2",
        parentId: null,
        kind: "assistant",
        cli: "opencode",
        sessionId: "s-oc2",
        projectId: project.id,
        timestamp: "2026-01-01T00:00:00.000Z",
        snapshotRef: null,
        label: null,
        summary: "",
        content: null,
        meta: { nativeUuid: "oc-2" },
      });
      const wrongCli = await request(app)
        .post(`/api/nodes/${encodeURIComponent("opencode:oc-2")}/rewind`)
        .send();
      expect(wrongCli.status).toBe(400);
    });
  });

  describe("POST /api/nodes/:id/restore — rewind companion field", () => {
    it("gains a `rewind` field (executed exact plan) when the transcript is available", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const { nodes } = await ingestFixture();
      await registerFixtureTranscript();

      const snapshotted = nodes.filter((n) => n.snapshotRef !== null);
      expect(snapshotted.length).toBeGreaterThan(0);
      const target = snapshotted[snapshotted.length - 1];

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent(target.id)}/restore`)
        .send();
      expect(res.status).toBe(200);
      expect(fs.existsSync(res.body.worktreePath)).toBe(true);
      expect(res.body.rewind).toBeDefined();
      expect(res.body.rewind.mode).toBe("exact");
      // The exact plan was EXECUTED: the synthesized transcript exists.
      expect(fs.existsSync(res.body.rewind.transcriptPath)).toBe(true);
    });

    it("V2 must-fix I3: the executed rewind's synthesized transcript ingests PARENTED to the restored node (meta.rewindOf) with zero flags — no disconnected phantom session", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const { nodes } = await ingestFixture();
      await registerFixtureTranscript();

      const snapshotted = nodes.filter((n) => n.snapshotRef !== null);
      const target = snapshotted[snapshotted.length - 1];

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent(target.id)}/restore`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body.rewind.mode).toBe("exact");
      const synthPath: string = res.body.rewind.transcriptPath;
      const newSessionId: string = res.body.rewind.newSessionId;

      // The provenance sidecar landed next to the synthesized transcript.
      const sidecarPath = synthPath.replace(/\.jsonl$/, ".sojourn-rewind.json");
      expect(fs.existsSync(sidecarPath)).toBe(true);
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
      expect(sidecar.originNodeId).toBe(target.id);

      // Simulate the daemon watcher picking the new .jsonl up (record in the
      // transcript index, then ingest) — exactly watcher.ts's scan() flow.
      const written = fs.readFileSync(synthPath, "utf8");
      const batch = parseSessionJsonl(synthPath, written)!;
      expect(batch.session.id).toBe(newSessionId);
      transcripts.record(newSessionId, {
        transcriptPath: synthPath,
        diskRoot: batch.project.root,
      });
      await ingestBatch(ingestDeps, batch);

      // Connected, not phantom: the synthesized session's root hangs off
      // the restored node via a rewind edge.
      const sessionNodes = store.getSessionNodes(newSessionId);
      expect(sessionNodes.length).toBeGreaterThan(0);
      const root = sessionNodes.find((n) => n.meta.rewindOf !== undefined);
      expect(root).toBeDefined();
      expect(root!.parentId).toBe(target.id);
      expect(root!.meta.rewindOf).toBe(target.id);

      // Synthesized history carries ZERO flags — a restore can never flip
      // `soj gate` red with fabricated verified findings.
      for (const n of sessionNodes) {
        expect(n.flags ?? []).toEqual([]);
      }
    });

    it("omits `rewind` when the session's transcript is not known (restore still succeeds)", async () => {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "v1");
      const node = mkNode("restore-norw", null, "assistant", "s-norw", "2026-01-01T00:00:00.000Z", {
        type: "text",
        text: "done",
      });
      await ingestBatch(ingestDeps, {
        project: { root: projectRoot, name: "test" },
        session: { id: "s-norw", cli: "claude" },
        nodes: [node],
      });

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent("claude:restore-norw")}/restore`)
        .send();
      expect(res.status).toBe(200);
      expect(fs.existsSync(res.body.worktreePath)).toBe(true);
      expect(res.body.rewind).toBeUndefined();
    });
  });

  describe("restore preflight/restore — retention-aware phrasing", () => {
    it("preflight names the retention policy when the tree is invalid; restore's 400 carries the same phrase", async () => {
      const project = store.upsertProject(projectRoot, "test");
      const node = mkNode("thinned-1", null, "assistant", "s-thinned", "2026-01-01T00:00:00.000Z", {
        type: "text",
        text: "done",
      });
      store.upsertNode({ ...node, projectId: project.id });

      const pf = await request(app)
        .post(`/api/nodes/${encodeURIComponent("claude:thinned-1")}/preflight`)
        .send();
      expect(pf.status).toBe(200);
      expect(pf.body.treeValid).toBe(false);
      expect(pf.body.warnings[0]).toContain("snapshot missing or thinned by retention policy (soj gc)");

      const restore = await request(app)
        .post(`/api/nodes/${encodeURIComponent("claude:thinned-1")}/restore`)
        .send();
      expect(restore.status).toBe(400);
      expect(restore.body.error).toContain(
        "snapshot missing or thinned by retention policy (soj gc)",
      );
    });
  });

  describe("POST /api/nodes/:id/flags/run — budgets (V2 must-fix I2)", () => {
    /** Ingests a two-turn session where turn 2's single assistant node makes
     * `count` DISTINCT false edit claims (nothing on disk changed during the
     * turn), so ingest-time budgeting keeps the flagship budget (10) plus
     * one digest. Returns the claim node's id. */
    async function ingestStormTurn(sess: string, count: number): Promise<string> {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "hello");
      const prompt1 = mkNode(`${sess}-p1`, null, "prompt", sess, "2026-01-01T00:00:00.000Z", "hi");
      const prior = mkNode(`${sess}-prior`, `${sess}-p1`, "assistant", sess, "2026-01-01T00:00:01.000Z", {
        type: "text",
        text: "Sure.",
      });
      await ingestBatch(ingestDeps, {
        project: { root: projectRoot, name: "test" },
        session: { id: sess, cli: "claude" },
        nodes: [prompt1, prior],
      });

      const stormText = Array.from({ length: count }, (_, i) => `I updated \`f${i}.py\`.`).join(" ");
      const prompt2 = mkNode(`${sess}-p2`, `${sess}-prior`, "prompt", sess, "2026-01-01T00:00:02.000Z", "go");
      const claim = mkNode(`${sess}-claim`, `${sess}-p2`, "assistant", sess, "2026-01-01T00:00:03.000Z", {
        type: "text",
        text: stormText,
      });
      await ingestBatch(ingestDeps, {
        project: { root: projectRoot, name: "test" },
        session: { id: sess, cli: "claude" },
        nodes: [prompt1, prior, prompt2, claim],
      });
      return `claude:${sess}-claim`;
    }

    function editClaimState(nodeId: string) {
      const flags = (store.getNode(nodeId)!.flags ?? []).filter(
        (f) => f.kind === "edit_claim_mismatch",
      );
      return {
        ordinary: flags.filter((f) => (f.suppressedCount ?? 0) === 0),
        digests: flags.filter((f) => (f.suppressedCount ?? 0) > 0),
      };
    }

    it("a manual T1 re-run on a storm node does NOT resurrect the digest's suppressed siblings: active flag set unchanged, suppressed_count reconciled, health stable", async () => {
      const claimId = await ingestStormTurn("s-i2-storm", 12);

      // Ingest-time budget state: flagship budget keeps 10, one digest
      // stands in for the 2 suppressed claims.
      const before = editClaimState(claimId);
      expect(before.ordinary).toHaveLength(10);
      expect(before.digests).toHaveLength(1);
      expect(before.digests[0].suppressedCount).toBe(2);

      const healthBefore = (await request(app).get("/api/sessions/s-i2-storm/health")).body;

      const res = await request(app)
        .post(`/api/nodes/${encodeURIComponent(claimId)}/flags/run`)
        .send({ tier: "T1" });
      expect(res.status).toBe(200);

      // The re-run reproduces the full storm, but the route must budget it
      // exactly like ingest: the previously-suppressed claims stay
      // suppressed (inside the digest), never inserted as fresh rows.
      const after = editClaimState(claimId);
      expect(after.ordinary).toHaveLength(10);
      expect(after.digests).toHaveLength(1);
      expect(after.digests[0].suppressedCount).toBe(2);

      // The route's response reflects the same budgeted state.
      const responseEditFlags = (res.body.flags as Array<Record<string, unknown>>).filter(
        (f) => f.kind === "edit_claim_mismatch",
      );
      expect(responseEditFlags).toHaveLength(11); // 10 kept + 1 digest

      // Session health counts are stable across the re-run.
      const healthAfter = (await request(app).get("/api/sessions/s-i2-storm/health")).body;
      expect(healthAfter).toEqual(healthBefore);
      expect(healthAfter.suppressed).toBe(2);
    });

    it("the T2 branch budgets advisory flags too (advisory budget 2 + one digest)", async () => {
      const claimId = await ingestStormTurn("s-i2-t2", 1);

      const fakeLlm = {
        complete: async () =>
          JSON.stringify({
            assumptions: [
              { text: "assumption one", confidence: "high" },
              { text: "assumption two", confidence: "medium" },
              { text: "assumption three", confidence: "low" },
              { text: "assumption four", confidence: "low" },
            ],
            possible_hallucinations: [],
          }),
      };
      const t2App = createApp({ ...baseDeps, criticFor: () => fakeLlm });

      const prevKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = "test-key";
      try {
        const res = await request(t2App)
          .post(`/api/nodes/${encodeURIComponent(claimId)}/flags/run`)
          .send({ tier: "T2" });
        expect(res.status).toBe(200);
      } finally {
        if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = prevKey;
      }

      const advisory = (store.getNode(claimId)!.flags ?? []).filter(
        (f) => f.kind === "unstated_assumption",
      );
      const ordinary = advisory.filter((f) => (f.suppressedCount ?? 0) === 0);
      const digests = advisory.filter((f) => (f.suppressedCount ?? 0) > 0);
      expect(ordinary).toHaveLength(2); // advisory per-turn budget
      expect(digests).toHaveLength(1);
      expect(digests[0].suppressedCount).toBe(2);
      for (const f of advisory) {
        expect(f.tier).toBe("advisory");
      }
    });
  });

  describe("POST /api/nodes/:id/flags/run — worktree-aliased disk root", () => {
    it("runs disk-reading checks against the worktree's ACTUAL root (manifest-verified), not the origin's mainline root", async () => {
      // Origin project + session (anchors the origin snapshot the aliased
      // session forks from).
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "mainline content");
      const originPrompt = mkNode("ar-op", null, "prompt", "s-ar-origin", "2026-01-01T00:00:00.000Z", "hi");
      const originReply = mkNode("ar-oa", "ar-op", "assistant", "s-ar-origin", "2026-01-01T00:00:01.000Z", {
        type: "text",
        text: "hello",
      });
      await ingestBatch(ingestDeps, {
        project: { root: projectRoot, name: "mainline" },
        session: { id: "s-ar-origin", cli: "claude" },
        nodes: [originPrompt, originReply],
      });
      const originNodeId = "claude:ar-oa";

      // Restored worktree: manifest -> origin node; a package that exists
      // ONLY in the worktree's node_modules; a new .js file importing it.
      const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-apiv2-aliasroot-"));
      tempDirs.push(worktreeRoot);
      await fsp.writeFile(
        path.join(worktreeRoot, ".sojourn-restore.json"),
        JSON.stringify({ nodeId: originNodeId }),
        "utf8",
      );
      await fsp.mkdir(path.join(worktreeRoot, "node_modules", "leftpadz"), { recursive: true });
      await fsp.writeFile(
        path.join(worktreeRoot, "uses.js"),
        'import lp from "leftpadz";\nexport default lp;\n',
        "utf8",
      );

      // Aliased session ingested from the worktree (fetchJson is 200 here,
      // so no flags land during ingest either way).
      const wtPrompt = mkNode("ar-wp", null, "prompt", "s-ar-wt", "2026-01-02T00:00:00.000Z", "continue");
      const wtReply = mkNode("ar-wa", "ar-wp", "assistant", "s-ar-wt", "2026-01-02T00:00:01.000Z", {
        type: "text",
        text: "Added the leftpadz usage.",
      });
      await ingestBatch(ingestDeps, {
        project: { root: worktreeRoot, name: "worktree-phantom" },
        session: { id: "s-ar-wt", cli: "claude" },
        nodes: [wtPrompt, wtReply],
      });
      expect(store.getNode("claude:ar-wa")!.snapshotRef).not.toBeNull();

      // Register the aliased session's ACTUAL disk root (as the watcher
      // does when it scans the worktree session's transcript).
      transcripts.record("s-ar-wt", {
        transcriptPath: path.join(projectsSubdir, "s-ar-wt.jsonl"),
        diskRoot: worktreeRoot,
      });

      // The registry mock 404s: a package missing from node_modules would be
      // flagged as hallucinated.
      const fetch404 = vi.fn(async () => ({ status: 404, body: null })) as unknown as FetchJson;

      // FIXED app (transcripts wired): the check probes the WORKTREE's
      // node_modules, finds leftpadz, and stays silent.
      const fixedApp = createApp({ ...baseDeps, fetchJson: fetch404 });
      const fixedRes = await request(fixedApp)
        .post(`/api/nodes/${encodeURIComponent("claude:ar-wa")}/flags/run`)
        .send({});
      expect(fixedRes.status).toBe(200);
      expect(
        fixedRes.body.flags.some((f: { kind: string }) => f.kind === "package_hallucination"),
      ).toBe(false);

      // CONTROL app (no transcript index): the check probes the ORIGIN's
      // mainline root, misses node_modules/leftpadz, asks the registry
      // (404) — and false-flags a package the session really has.
      const controlApp = createApp({ ...baseDeps, fetchJson: fetch404, transcripts: undefined });
      const controlRes = await request(controlApp)
        .post(`/api/nodes/${encodeURIComponent("claude:ar-wa")}/flags/run`)
        .send({});
      expect(controlRes.status).toBe(200);
      expect(
        controlRes.body.flags.some((f: { kind: string }) => f.kind === "package_hallucination"),
      ).toBe(true);
    });
  });

  describe("harvest routes", () => {
    async function setupHarvestOrigin(sess: string): Promise<ChronoNode> {
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "line1\nline2\n");
      const p = mkNode(`${sess}-p`, null, "prompt", sess, "2026-01-01T00:00:00.000Z", "hi");
      const a = mkNode(`${sess}-a`, `${sess}-p`, "assistant", sess, "2026-01-01T00:00:01.000Z", {
        type: "text",
        text: "hello",
      });
      await ingestBatch(ingestDeps, {
        project: { root: projectRoot, name: "mainline" },
        session: { id: sess, cli: "claude" },
        nodes: [p, a],
      });
      const origin = store.getNode(`claude:${sess}-a`)!;
      expect(origin.snapshotRef).not.toBeNull();
      return origin;
    }

    async function makeWorktree(
      origin: ChronoNode,
      files: Record<string, string>,
    ): Promise<string> {
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-apiv2-harvest-wt-"));
      tempDirs.push(wt);
      await fsp.writeFile(
        path.join(wt, ".sojourn-restore.json"),
        JSON.stringify({ nodeId: origin.id, treeHash: origin.snapshotRef }),
        "utf8",
      );
      for (const [rel, content] of Object.entries(files)) {
        await fsp.mkdir(path.dirname(path.join(wt, rel)), { recursive: true });
        await fsp.writeFile(path.join(wt, rel), content, "utf8");
      }
      return wt;
    }

    it("preflight classifies files against the manifest's base tree (clean new file, quiet mainline)", async () => {
      const origin = await setupHarvestOrigin("s-hv-pf");
      const wt = await makeWorktree(origin, {
        "a.txt": "line1\nline2\n",
        "feature.txt": "new stuff\n",
      });

      const res = await request(app)
        .post("/api/worktrees/harvest/preflight")
        .send({ worktreePath: wt });
      expect(res.status).toBe(200);
      expect(res.body.worktreePath).toBe(wt);
      expect(res.body.originNodeId).toBe(origin.id);
      expect(res.body.baseTree).toBe(origin.snapshotRef);
      expect(typeof res.body.branchTree).toBe("string");
      expect(res.body.files).toEqual([{ path: "feature.txt", status: "clean" }]);
      expect(res.body.mainlineDirty).toBe(false);
      expect(res.body.warnings.join(" ")).toContain("safety snapshot");
    });

    it("apply mode: clean edits land on the mainline, a merge node closes the fork, and WS events fire", async () => {
      const origin = await setupHarvestOrigin("s-hv-apply");
      const wt = await makeWorktree(origin, {
        "a.txt": "line1\nline2\n",
        "feature.txt": "new stuff\n",
      });

      const res = await request(app)
        .post("/api/worktrees/harvest")
        .send({ worktreePath: wt, mode: "apply" });
      expect(res.status).toBe(200);
      expect(res.body.applied).toEqual(["feature.txt"]);
      expect(res.body.conflicted).toEqual([]);
      expect(res.body.patchPath).toBeNull();
      expect(typeof res.body.safetySnapshotRef).toBe("string");
      expect(res.body.safetySnapshotRef.length).toBeGreaterThan(0);

      // The file actually landed on the mainline.
      expect(fs.readFileSync(path.join(projectRoot, "feature.txt"), "utf8")).toBe("new stuff\n");

      // Graph closure: checkpoint node parented to the origin, broadcast.
      expect(res.body.mergeNodeId).toBeTruthy();
      const mergeNode = store.getNode(res.body.mergeNodeId)!;
      expect(mergeNode.kind).toBe("checkpoint");
      expect(mergeNode.parentId).toBe(origin.id);
      const added = sink.events.filter(
        (e): e is Extract<SojournEvent, { type: "node_added" }> => e.type === "node_added",
      );
      expect(added.some((e) => e.node.id === res.body.mergeNodeId)).toBe(true);
    });

    it("apply mode aborts clean on conflicts (400, typed code, no mainline write) unless allowConflicts writes markers", async () => {
      const origin = await setupHarvestOrigin("s-hv-conflict");
      const wt = await makeWorktree(origin, { "a.txt": "line1\nbranch\n" });
      // Mainline moved on the same line since the restore point.
      await fsp.writeFile(path.join(projectRoot, "a.txt"), "line1\nmainline\n");

      const refused = await request(app)
        .post("/api/worktrees/harvest")
        .send({ worktreePath: wt, mode: "apply" });
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("conflicts");
      expect(refused.body.files).toEqual(["a.txt"]);
      // Abort-clean: the mainline is untouched.
      expect(fs.readFileSync(path.join(projectRoot, "a.txt"), "utf8")).toBe("line1\nmainline\n");

      const withMarkers = await request(app)
        .post("/api/worktrees/harvest")
        .send({ worktreePath: wt, mode: "apply", allowConflicts: true });
      expect(withMarkers.status).toBe(200);
      expect(withMarkers.body.conflicted).toEqual(["a.txt"]);
      expect(fs.readFileSync(path.join(projectRoot, "a.txt"), "utf8")).toContain("<<<<<<<");
    });

    it("patch mode writes the patch into the worktree and never touches the mainline", async () => {
      const origin = await setupHarvestOrigin("s-hv-patch");
      const wt = await makeWorktree(origin, {
        "a.txt": "line1\nline2\n",
        "feature.txt": "new stuff\n",
      });

      const res = await request(app)
        .post("/api/worktrees/harvest")
        .send({ worktreePath: wt, mode: "patch" });
      expect(res.status).toBe(200);
      expect(res.body.applied).toEqual([]);
      expect(res.body.patchPath).toBe(path.join(wt, ".sojourn-harvest.patch"));
      expect(fs.existsSync(res.body.patchPath)).toBe(true);
      expect(fs.readFileSync(res.body.patchPath, "utf8")).toContain("feature.txt");
      expect(fs.existsSync(path.join(projectRoot, "feature.txt"))).toBe(false);
    });

    it("400s: missing worktreePath, bad mode, no manifest, manifest referencing an unknown node", async () => {
      const noPath = await request(app).post("/api/worktrees/harvest/preflight").send({});
      expect(noPath.status).toBe(400);

      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-apiv2-nomanifest-"));
      tempDirs.push(emptyDir);
      const noManifest = await request(app)
        .post("/api/worktrees/harvest/preflight")
        .send({ worktreePath: emptyDir });
      expect(noManifest.status).toBe(400);
      expect(noManifest.body.code).toBe("no_manifest");

      const unknownDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-apiv2-unknownnode-"));
      tempDirs.push(unknownDir);
      await fsp.writeFile(
        path.join(unknownDir, ".sojourn-restore.json"),
        JSON.stringify({ nodeId: "claude:never-existed" }),
        "utf8",
      );
      const unknownNode = await request(app)
        .post("/api/worktrees/harvest")
        .send({ worktreePath: unknownDir, mode: "apply" });
      expect(unknownNode.status).toBe(400);
      expect(unknownNode.body.code).toBe("no_manifest");

      const origin = await setupHarvestOrigin("s-hv-badmode");
      const wt = await makeWorktree(origin, { "a.txt": "line1\nline2\n" });
      const badMode = await request(app)
        .post("/api/worktrees/harvest")
        .send({ worktreePath: wt, mode: "yolo" });
      expect(badMode.status).toBe(400);
      expect(badMode.body.error).toContain("apply|patch");
    });

    it("maps typed engine errors: stale_base -> 400; partial_apply -> 500 WITH the honest .partial payload", async () => {
      const origin = await setupHarvestOrigin("s-hv-typed");
      const wt = await makeWorktree(origin, { "a.txt": "line1\nline2\n" });

      const stubApp = createApp({
        ...baseDeps,
        harvestEngine: {
          preflight: async (): Promise<HarvestPreflight> => {
            throw new SojournHarvestError("base tree is gone", "stale_base");
          },
          harvest: async () => {
            throw new SojournHarvestError("failed mid-apply at x.txt", "partial_apply", ["x.txt"], {
              applied: ["a.txt"],
              conflicted: [],
              remaining: ["x.txt"],
              safetySnapshotRef: "deadbeef",
            });
          },
        },
      });

      const stale = await request(stubApp)
        .post("/api/worktrees/harvest/preflight")
        .send({ worktreePath: wt });
      expect(stale.status).toBe(400);
      expect(stale.body.code).toBe("stale_base");

      const partial = await request(stubApp)
        .post("/api/worktrees/harvest")
        .send({ worktreePath: wt, mode: "apply" });
      expect(partial.status).toBe(500);
      expect(partial.body.code).toBe("partial_apply");
      expect(partial.body.files).toEqual(["x.txt"]);
      expect(partial.body.partial).toEqual({
        applied: ["a.txt"],
        conflicted: [],
        remaining: ["x.txt"],
        safetySnapshotRef: "deadbeef",
      });
    });
  });
});
