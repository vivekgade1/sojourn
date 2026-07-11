#!/usr/bin/env node
/**
 * Full-surface API checker: exercises every route in docs/API.md plus the
 * WebSocket against the ISOLATED e2e daemon, asserting scenario outcomes
 * from the generator's manifest. Emits a machine-readable report and exits
 * non-zero on any failure.
 *
 * Env: E2E_PORT, E2E_OUT (manifest path from gen-session), E2E_REPORT.
 */
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const PORT = process.env.E2E_PORT ?? "4199";
const BASE = `http://localhost:${PORT}`;
const manifest = JSON.parse(await fs.readFile(process.env.E2E_OUT, "utf8"));
const REPORT = process.env.E2E_REPORT ?? "/tmp/sojourn-e2e-report.json";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (err) {
    results.push({ name, status: "FAIL", detail: err?.message ?? String(err) });
  }
}
function skip(name, reason) {
  results.push({ name, status: "SKIP", detail: reason });
}
const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};

const json = async (route, init) => {
  const res = await fetch(`${BASE}${route}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
};
const enc = encodeURIComponent;
const post = (route, body) =>
  json(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const pid = manifest.projectId;
let graph = null;
const nodeById = (id) => graph.nodes.find((n) => n.id === id);
const activeFlags = (node, kind) =>
  (node?.flags ?? []).filter((f) => f.kind === kind && !f.dismissed && !f.autoResolved);

// ---------- basics ----------
await check("GET /api/health", async () => {
  const r = await json("/api/health");
  eq(r.status, 200, "status");
  ok(r.body.ok === true && typeof r.body.version === "string", "shape");
});

await check("GET / serves the built web UI", async () => {
  const res = await fetch(`${BASE}/`);
  eq(res.status, 200, "status");
  ok((await res.text()).includes("<div id=\"root\">"), "html root div");
});

await check("GET /api/projects includes the e2e project", async () => {
  const r = await json("/api/projects");
  eq(r.status, 200, "status");
  ok(r.body.some((p) => p.id === pid), `project ${pid} listed`);
});

await check("GET /api/projects/:id/graph returns sessions + flagged nodes", async () => {
  const r = await json(`/api/projects/${enc(pid)}/graph`);
  eq(r.status, 200, "status");
  graph = r.body;
  ok(graph.nodes.length >= manifest.expectedMinNodes, `>=${manifest.expectedMinNodes} nodes`);
  eq(graph.sessions.length >= 2, true, "two sessions");
});

if (!graph) {
  console.error("graph unavailable — aborting scenario checks");
} else {
  // ---------- scenario outcomes (the product's core promises) ----------
  const s = manifest.scenarios;

  await check("truthful edit claim is NOT flagged (precision)", async () => {
    const flags = activeFlags(nodeById(s.truthfulEdit.nodeId), "edit_claim_mismatch");
    eq(flags.length, 0, "edit_claim_mismatch count");
  });

  await check("false edit claim IS flagged high with evidence", async () => {
    // Turn 10 auto-resolves this flag BY DESIGN — assert the flag was
    // created with the right strength; its resolution is asserted separately.
    const flags = (nodeById(s.falseEdit.nodeId)?.flags ?? []).filter(
      (f) => f.kind === "edit_claim_mismatch" && !f.dismissed,
    );
    ok(flags.length >= 1, "flag present");
    eq(flags[0].tier, "verified", "tier");
    eq(flags[0].confidence, "high", "confidence");
    ok(flags[0].evidence.includes("auth.py"), "evidence names the claimed file");
  });

  {
    let online = true;
    try {
      const probe = await fetch("https://pypi.org/pypi/requests/json", {
        signal: AbortSignal.timeout(4000),
      });
      online = probe.status === 200;
    } catch {
      online = false;
    }
    if (online) {
      await check("nonexistent import IS flagged package_hallucination", async () => {
        const flags = activeFlags(nodeById(s.packageHallucination.nodeId), "package_hallucination");
        ok(flags.length >= 1, "flag present");
        ok(flags[0].evidence.includes("totally_unreal_pkg_zx91"), "evidence names the package");
      });
    } else {
      skip("nonexistent import IS flagged package_hallucination", "registry unreachable (fail-open by design)");
    }
  }

  await check("missing file reference IS flagged", async () => {
    ok(activeFlags(nodeById(s.missingFileRef.nodeId), "file_ref_missing").length >= 1, "flag present");
  });

  await check("missing symbol IS flagged", async () => {
    ok(activeFlags(nodeById(s.missingSymbol.nodeId), "symbol_not_found").length >= 1, "flag present");
  });

  await check("'tests pass' with no observed run IS flagged", async () => {
    ok(activeFlags(nodeById(s.testClaimNoRun.nodeId), "test_claim_unverified").length >= 1, "flag present");
  });

  await check("'tests pass' after a FAILING run IS flagged high", async () => {
    const flags = activeFlags(nodeById(s.testClaimFailingRun.nodeId), "test_claim_unverified");
    ok(flags.length >= 1, "flag present");
    eq(flags[0].confidence, "high", "confidence");
  });

  await check("'tests pass' after a PASSING run is NOT flagged (precision)", async () => {
    eq(activeFlags(nodeById(s.testClaimPassingRun.nodeId), "test_claim_unverified").length, 0, "count");
  });

  await check("earlier false-edit flag AUTO-RESOLVES after the real edit", async () => {
    const node = nodeById(s.falseEdit.nodeId);
    const resolved = (node?.flags ?? []).filter(
      (f) => f.kind === "edit_claim_mismatch" && f.autoResolved,
    );
    ok(resolved.length >= 1, "autoResolved flag present");
    eq(activeFlags(node, "edit_claim_mismatch").length, 0, "no still-active copy");
  });

  await check("parallel tool_use blocks are SIBLINGS under the text node", async () => {
    const [tool1, tool2] = s.parallelSiblings.toolNodeIds.map(nodeById);
    ok(tool1 && tool2, "both tool nodes exist");
    eq(tool1.parentId, tool2.parentId, "shared parent");
    eq(tool1.parentId, s.parallelSiblings.textNodeId, "parent is the text node");
  });

  await check("second session appears as its own session", async () => {
    ok(graph.sessions.some((sess) => sess.id === manifest.sessionB), "session B listed");
  });

  // ---------- per-node routes ----------
  const flaggedId = s.testClaimFailingRun.nodeId;
  const snapshottedNode = [...graph.nodes].reverse().find((n) => n.snapshotRef);

  await check("GET /api/nodes/:id returns the node with flags", async () => {
    const r = await json(`/api/nodes/${enc(flaggedId)}`);
    eq(r.status, 200, "status");
    ok(Array.isArray(r.body.flags), "flags array");
  });

  await check("GET /api/nodes/:id 404s JSON on unknown id", async () => {
    const r = await json(`/api/nodes/${enc("claude:no-such-node")}`);
    eq(r.status, 404, "status");
    ok(typeof r.body?.error === "string", "error JSON");
  });

  await check("GET /api/nodes/:id/diff returns changes for a snapshotted node", async () => {
    const r = await json(`/api/nodes/${enc(snapshottedNode.id)}/diff`);
    eq(r.status, 200, "status");
    ok(Array.isArray(r.body.changes), "changes array");
  });

  await check("GET /api/nodes/:id/diff/file returns a patch string", async () => {
    const r = await json(`/api/nodes/${enc(snapshottedNode.id)}/diff/file?path=src/auth.py`);
    eq(r.status, 200, "status");
    ok(typeof r.body.patch === "string", "patch string");
  });

  await check("POST flags/run T1 is idempotent (dedup — no flag inflation)", async () => {
    const before = activeFlags(nodeById(flaggedId), "test_claim_unverified").length;
    const r = await post(`/api/nodes/${enc(flaggedId)}/flags/run`, {});
    eq(r.status, 200, "status");
    const after = r.body.flags.filter(
      (f) => f.kind === "test_claim_unverified" && !f.dismissed && !f.autoResolved,
    ).length;
    eq(after, before, "active flag count unchanged");
  });

  await check("POST flags/run T2 without ANTHROPIC_API_KEY -> 400 JSON", async () => {
    const r = await post(`/api/nodes/${enc(flaggedId)}/flags/run`, { tier: "T2" });
    eq(r.status, 400, "status");
    ok(/ANTHROPIC_API_KEY/.test(r.body?.error ?? ""), "error names the key");
  });

  // ---------- marks, annotations, dismissal ----------
  for (const kind of ["decision", "assumption", "checkpoint"]) {
    await check(`POST /api/mark creates a ${kind} node at the session tip`, async () => {
      const r = await post("/api/mark", {
        sessionId: manifest.sessionA,
        label: `e2e ${kind}`,
        kind,
      });
      eq(r.status, 200, "status");
      eq(r.body.kind, kind, "kind");
      ok(r.body.parentId, "parented");
    });
  }

  await check("POST /api/mark rejects an invalid kind with 400 JSON", async () => {
    const r = await post("/api/mark", { sessionId: manifest.sessionA, label: "x", kind: "vibe" });
    eq(r.status, 400, "status");
    ok(typeof r.body?.error === "string", "error JSON");
  });

  await check("POST annotations adds and GET returns it", async () => {
    const r = await post(`/api/nodes/${enc(flaggedId)}/annotations`, { text: "e2e note" });
    eq(r.status, 200, "status");
    const node = await json(`/api/nodes/${enc(flaggedId)}`);
    ok(node.body.annotations.some((a) => a.text === "e2e note"), "annotation visible");
  });

  await check("POST /api/flags/:id/dismiss hides the flag from active views", async () => {
    const node = nodeById(s.testClaimNoRun.nodeId);
    const flag = activeFlags(node, "test_claim_unverified")[0];
    ok(flag, "flag to dismiss exists");
    const r = await post(`/api/flags/${flag.id}/dismiss`);
    eq(r.status, 200, "status");
    const after = await json(`/api/nodes/${enc(node.id)}`);
    const same = after.body.flags.find((f) => f.id === flag.id);
    eq(same.dismissed, true, "dismissed persisted");
  });

  // ---------- restore (the data-loss-critical path) ----------
  await check("preflight -> restore lands a worktree with node-time files, project untouched", async () => {
    const pf = await post(`/api/nodes/${enc(snapshottedNode.id)}/preflight`);
    eq(pf.status, 200, "preflight status");
    eq(pf.body.treeValid, true, "treeValid");
    ok(pf.body.warnings.length >= 4, "side-effect warnings present");

    const before = await fs.readFile(path.join(manifest.project, "src", "app.py"), "utf8");
    const r = await post(`/api/nodes/${enc(snapshottedNode.id)}/restore`);
    eq(r.status, 200, "restore status");
    const wt = r.body.worktreePath;
    ok((await fs.readFile(path.join(wt, "src", "app.py"), "utf8")).length > 0, "restored file");
    const manifestFile = JSON.parse(
      await fs.readFile(path.join(wt, ".sojourn-restore.json"), "utf8"),
    );
    eq(manifestFile.nodeId, snapshottedNode.id, "manifest nodeId");
    ok(manifestFile.safetySnapshotRef, "safety snapshot recorded");
    const after = await fs.readFile(path.join(manifest.project, "src", "app.py"), "utf8");
    eq(after, before, "project root untouched");
  });

  await check("restore of a snapshot-less root 400s with typed JSON error", async () => {
    const bare = graph.nodes.find((n) => !n.snapshotRef && !n.parentId);
    if (!bare) throw new Error("no snapshot-less root in graph (fixture drift)");
    const r = await post(`/api/nodes/${enc(bare.id)}/restore`);
    eq(r.status, 400, "status");
    ok(typeof r.body?.error === "string", "error JSON");
  });

  // ---------- error handling + hooks ----------
  await check("malformed JSON body -> 400 with JSON error (never HTML)", async () => {
    const res = await fetch(`${BASE}/api/mark`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    eq(res.status, 400, "status");
    ok((res.headers.get("content-type") ?? "").includes("application/json"), "json content-type");
    ok(typeof (await res.json()).error === "string", "error field");
  });

  await check("unknown /api route -> 404 JSON (not SPA fallback)", async () => {
    const r = await json("/api/definitely-not-a-route");
    eq(r.status, 404, "status");
    ok(typeof r.body?.error === "string", "error JSON");
  });

  await check("hooks/claude rejects transcript paths outside CLAUDE_CONFIG_DIR (200, no read)", async () => {
    const before = (await json(`/api/projects/${enc(pid)}/graph`)).body.nodes.length;
    const r = await post("/api/hooks/claude", {
      session_id: "evil",
      transcript_path: "/etc/passwd",
      cwd: manifest.project,
      hook_event_name: "PostToolUse",
    });
    eq(r.status, 200, "status (fail-soft)");
    await new Promise((res) => setTimeout(res, 500));
    const after = (await json(`/api/projects/${enc(pid)}/graph`)).body.nodes.length;
    eq(after, before, "no nodes ingested from outside path");
  });

  await check("hooks/opencode is fail-soft 200 without a live OpenCode server", async () => {
    const r = await post("/api/hooks/opencode", { sessionId: "nope" });
    eq(r.status, 200, "status");
  });

  // ---------- websocket ----------
  await check("WS /ws connects and delivers a node_added within 8s of new activity", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const gotEvent = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no ws event within 8s")), 8000);
      ws.on("message", (data) => {
        try {
          const evt = JSON.parse(String(data));
          if (evt.type === "node_added" || evt.type === "project_updated") {
            clearTimeout(timer);
            resolve(evt);
          }
        } catch {
          /* ignore */
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    // Trigger activity: append a marker turn to session B and hook-rescan it.
    const file = path.join(
      path.dirname(manifest.project),
      "claude",
      "projects",
      "-e2e-proj",
      `${manifest.sessionB}.jsonl`,
    );
    const realFile = process.env.E2E_CLAUDE_DIR
      ? path.join(process.env.E2E_CLAUDE_DIR, "projects", "-e2e-proj", `${manifest.sessionB}.jsonl`)
      : file;
    await fs.appendFile(
      realFile,
      JSON.stringify({
        type: "user",
        uuid: `e2e-ws-${Date.now()}`,
        parentUuid: null,
        sessionId: manifest.sessionB,
        cwd: manifest.project,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "ws marker" },
      }) + "\n",
    );
    await post("/api/hooks/claude", {
      session_id: manifest.sessionB,
      transcript_path: realFile,
      cwd: manifest.project,
      hook_event_name: "PostToolUse",
    });
    await gotEvent;
    ws.close();
  });
}

// ---------- report ----------
const failed = results.filter((r) => r.status === "FAIL");
const report = {
  base: BASE,
  total: results.length,
  passed: results.filter((r) => r.status === "PASS").length,
  skipped: results.filter((r) => r.status === "SKIP").length,
  failed: failed.length,
  results,
};
await fs.writeFile(REPORT, JSON.stringify(report, null, 2), "utf8");
for (const r of results) {
  console.error(`${r.status.padEnd(4)} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.error(`\n[api-check] ${report.passed}/${report.total} passed, ${report.failed} failed, ${report.skipped} skipped -> ${REPORT}`);
process.exit(failed.length > 0 ? 1 : 0);
