/**
 * Scale stress: ingest a deterministic ~12k-line transcript (seeded PRNG,
 * modeled on scripts/e2e/fixtures/gen-thousand.mjs but bigger, plus a few
 * ~100KB tool_result payloads) through the REAL ingestBatch with a real
 * file-backed GraphStore and a real ShadowSnapshotter.
 *
 * This is the crash-class regression test for the live incident where the
 * daemon died silently ~60s into ingesting an 11k-step transcript: the flag
 * phase used to re-materialize the ENTIRE session once per assistant node
 * and retain every copy (O(n²) memory) — a guaranteed heap OOM on big
 * first-scan batches. Reproduced: before the ingest.ts scale guards this
 * exact workload OOM'd a 1.5GB-heap node process in ~36s; with them it
 * completes in seconds with a couple hundred MB of peak growth.
 *
 * Guards: completes without throwing, ingests every node, and peak RSS
 * growth stays far under 1.5GB.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GraphStore, ShadowSnapshotter, FlagEngine } from "@sojourn/core";
import type { FetchJson, Project, SnapshotterLike } from "@sojourn/core";
import { parseSessionJsonl } from "@sojourn/adapter-claude";
import { ingestBatch, type IngestDeps } from "../src/ingest.js";

const SEED = 20260713;
const TURNS = 3400; // ~12k transcript lines at ~3.5 lines/turn

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOLS = ["Read", "Write", "Edit", "Bash", "Grep"];
const FILES = Array.from({ length: 40 }, (_, i) => `src/module_${i}.ts`);
const ASKS = ["Check the module.", "Update the handler.", "Run checks.", "Refactor the loop."];
const GISTS = [
  "Looked at the module; nothing unusual so far.",
  "Updated the handler with structured logging.",
  "Refactored the loop, allocation removed.",
  "Traced the slow path to the serializer.",
];
const BIG_PAYLOAD = "payload-".repeat(12800); // ~100KB

/** Deterministic ~12k-line Claude-session JSONL (seeded — reruns are byte-identical). */
function generateLines(cwd: string): string[] {
  const rng = mulberry32(SEED);
  const randInt = (max: number) => Math.floor(rng() * max);
  let clock = Date.parse("2026-03-01T00:00:00.000Z");
  const ts = () => new Date((clock += 1500)).toISOString();
  let seq = 0;
  const uid = (tag: string) => `s${String(++seq).padStart(6, "0")}-${tag}`;
  const lines: string[] = [];
  const push = (obj: unknown) => lines.push(JSON.stringify(obj));
  let lastUuid: string | null = null;
  let resultCount = 0;

  for (let turn = 0; turn < TURNS; turn++) {
    const uUuid = uid("u");
    push({
      type: "user",
      uuid: uUuid,
      parentUuid: lastUuid,
      sessionId: "stress-session",
      cwd,
      timestamp: ts(),
      isSidechain: false,
      message: { role: "user", content: `${ASKS[randInt(ASKS.length)]} (turn ${turn})` },
    });
    lastUuid = uUuid;

    const nTools = randInt(4); // 0..3 parallel tool_use blocks
    const aUuid = uid("a");
    const blocks: unknown[] = [{ type: "text", text: GISTS[randInt(GISTS.length)] }];
    const toolIds: string[] = [];
    for (let t = 0; t < nTools; t++) {
      const toolId = uid("t");
      toolIds.push(toolId);
      const tool = TOOLS[randInt(TOOLS.length)];
      const file = FILES[randInt(FILES.length)];
      blocks.push({
        type: "tool_use",
        id: toolId,
        name: tool,
        input: tool === "Bash" ? { command: `npm test -- ${file}` } : { file_path: file },
      });
    }
    push({
      type: "assistant",
      uuid: aUuid,
      parentUuid: lastUuid,
      sessionId: "stress-session",
      cwd,
      timestamp: ts(),
      isSidechain: false,
      message: { role: "assistant", content: blocks },
    });
    lastUuid = aUuid;

    for (const toolId of toolIds) {
      resultCount += 1;
      const rUuid = uid("r");
      // A few ~100KB tool_result payloads sprinkled deterministically.
      const big = resultCount % 400 === 0;
      push({
        type: "user",
        uuid: rUuid,
        parentUuid: aUuid,
        sessionId: "stress-session",
        cwd,
        timestamp: ts(),
        isSidechain: false,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolId, content: big ? BIG_PAYLOAD : "ok" }],
        },
        toolUseResult: { success: true },
      });
      lastUuid = rUuid;
    }
  }
  return lines;
}

describe("ingestBatch at scale (11k-step crash class)", () => {
  let projectRoot: string;
  let shadowDir: string;
  let workDir: string;
  let store: GraphStore;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-stress-project-"));
    shadowDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-stress-shadow-"));
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-stress-work-"));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(projectRoot, "src", `module_${i}.ts`), `export const x${i} = ${i};\n`);
    }
    store = new GraphStore(path.join(workDir, "graph.db"));
  });

  afterEach(() => {
    store.close();
    for (const d of [projectRoot, shadowDir, workDir]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it(
    "ingests a ~12k-line transcript in one batch without throwing and within a 1.5GB RSS budget",
    async () => {
      const lines = generateLines(projectRoot);
      expect(lines.length).toBeGreaterThan(11_000); // "~12k lines"

      const transcriptPath = path.join(workDir, "stress-session.jsonl");
      const raw = lines.join("\n") + "\n";
      fs.writeFileSync(transcriptPath, raw, "utf8");

      const batch = parseSessionJsonl(transcriptPath, raw);
      expect(batch).not.toBeNull();

      const snapshotters = new Map<string, SnapshotterLike>();
      const deps: IngestDeps = {
        store,
        flagEngine: new FlagEngine(),
        events: { broadcast() {} },
        // Never touch the network: registry checks see an instant 404.
        fetchJson: (async () => ({ status: 404, body: null })) as FetchJson,
        snapshotterFor(project: Project): SnapshotterLike {
          const key = `${project.id}::${project.root}`;
          let snap = snapshotters.get(key);
          if (!snap) {
            snap = new ShadowSnapshotter({ projectRoot: project.root, shadowDir });
            snapshotters.set(key, snap);
          }
          return snap;
        },
      };

      // Peak RSS: sampled on an interval AND at the end (long synchronous
      // stretches can starve the timer, so the final sample always counts).
      const rssBefore = process.memoryUsage().rss;
      let peakRss = rssBefore;
      const sampler = setInterval(() => {
        const rss = process.memoryUsage().rss;
        if (rss > peakRss) peakRss = rss;
      }, 200);
      sampler.unref();

      let result: Awaited<ReturnType<typeof ingestBatch>>;
      try {
        result = await ingestBatch(deps, batch!);
      } finally {
        clearInterval(sampler);
      }
      const rssAfter = process.memoryUsage().rss;
      if (rssAfter > peakRss) peakRss = rssAfter;

      // Completed, and completely: every parsed node landed.
      expect(result.added.length).toBe(batch!.nodes.length);
      expect(store.getSessionNodes("stress-session").length).toBe(batch!.nodes.length);

      // The crash-class guard: before the ingest.ts scale fixes this
      // workload OOM'd a 1.5GB heap; the budget must hold with lots of room.
      const peakDelta = peakRss - rssBefore;
      expect(peakDelta).toBeLessThan(1.5 * 1024 * 1024 * 1024);
    },
    180_000,
  );
});
