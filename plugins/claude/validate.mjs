#!/usr/bin/env node
/**
 * Validates the packaged Claude Code plugin end to end:
 *
 *   (a) runs the bundler (`node scripts/build-plugin.mjs`) fresh
 *   (b) spawns the BUILT hook (plugins/claude/hooks/sojourn-hook.mjs)
 *       exactly the way hooks.json invokes it — no `node` prefix, relying
 *       on the shebang + exec bit — against a stub HTTP server standing in
 *       for the daemon, feeding it a fake hook payload on stdin, and
 *       asserts the process exits 0 AND the stub actually received a
 *       POST /api/hooks/claude request
 *   (c) parses hooks.json and asserts every hook command resolves to a
 *       path INSIDE this plugin directory (no `${CLAUDE_PLUGIN_ROOT}/../..`
 *       escape back into the repo) and that the resolved file exists
 *
 * Usage: node plugins/claude/validate.mjs   (wired as `npm run validate:plugin`)
 * Exits non-zero iff any check FAILs.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = __dirname; // plugins/claude
const REPO_ROOT = path.resolve(PLUGIN_DIR, "..", "..");
const HOOK_PATH = path.join(PLUGIN_DIR, "hooks", "sojourn-hook.mjs");
const HOOKS_JSON_PATH = path.join(PLUGIN_DIR, "hooks", "hooks.json");

const results = [];
function pass(name, detail) {
  results.push({ name, status: "PASS", detail });
}
function fail(name, detail) {
  results.push({ name, status: "FAIL", detail });
}
function assertOk(cond, name, detail) {
  cond ? pass(name, detail) : fail(name, detail ?? "assertion failed");
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
  });
}

// ---------------------------------------------------------------------------
// (a) run the bundle build fresh
// ---------------------------------------------------------------------------
{
  const { code, stdout, stderr } = await run("node", [path.join(REPO_ROOT, "scripts", "build-plugin.mjs")]);
  assertOk(code === 0, "build-plugin.mjs exits 0", code === 0 ? stdout.trim() : stderr.trim());
}

assertOk(fs.existsSync(HOOK_PATH), "bundled hook exists at plugins/claude/hooks/sojourn-hook.mjs");

if (fs.existsSync(HOOK_PATH)) {
  const mode = fs.statSync(HOOK_PATH).mode;
  const isExecutable = (mode & 0o111) !== 0;
  assertOk(isExecutable, "bundled hook has an executable bit set", `mode=${(mode & 0o777).toString(8)}`);

  const firstLine = fs.readFileSync(HOOK_PATH, "utf8").split("\n")[0];
  assertOk(
    firstLine === "#!/usr/bin/env node",
    "bundled hook has exactly one node shebang on line 1",
    `firstLine=${JSON.stringify(firstLine)}`,
  );
}

// ---------------------------------------------------------------------------
// (b) spawn the built hook against a stub daemon, the way hooks.json does
// ---------------------------------------------------------------------------
async function withStubServer(fn) {
  let received = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = { method: req.method, url: req.url, body: tryParse(body) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await fn(port, () => received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

if (fs.existsSync(HOOK_PATH)) {
  const fakePayload = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "validate-plugin-fake-session",
    transcript_path: "/dev/null",
    cwd: REPO_ROOT,
  });

  const { code, received } = await withStubServer(async (port, getReceived) => {
    const child = spawn(HOOK_PATH, [], {
      cwd: REPO_ROOT,
      env: { ...process.env, SOJOURN_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(fakePayload);
    child.stdin.end();
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((resolve) => {
      child.on("close", resolve);
      child.on("error", () => resolve(-1));
    });
    if (code !== 0 && stderr) console.error(`[validate-plugin] hook stderr: ${stderr}`);
    return { code, received: getReceived() };
  });

  assertOk(code === 0, "spawned hook (direct exec, no `node` prefix) exits 0 against a stub daemon", `code=${code}`);
  assertOk(
    received !== null && received.method === "POST" && received.url === "/api/hooks/claude",
    "stub daemon received POST /api/hooks/claude from the spawned hook",
    received ? `method=${received.method} url=${received.url}` : "no request arrived",
  );
  assertOk(
    received?.body?.session_id === "validate-plugin-fake-session",
    "forwarded request body matches the fake hook payload",
    `body=${JSON.stringify(received?.body)}`,
  );
} else {
  fail("spawned hook exits 0 against a stub daemon", "bundled hook missing, skipped spawn checks");
}

// ---------------------------------------------------------------------------
// (c) hooks.json commands resolve INSIDE the plugin dir, no ../.. escapes
// ---------------------------------------------------------------------------
{
  const hooksConfig = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, "utf8"));
  const commands = [];
  for (const eventHooks of Object.values(hooksConfig.hooks ?? {})) {
    for (const matcher of eventHooks) {
      for (const h of matcher.hooks ?? []) {
        if (h.type === "command" && typeof h.command === "string") commands.push(h.command);
      }
    }
  }
  assertOk(commands.length > 0, "hooks.json declares at least one command hook", `count=${commands.length}`);

  for (const [i, command] of commands.entries()) {
    assertOk(
      !command.includes(".."),
      `hooks.json command #${i} has no repo-relative "../.." escape`,
      command,
    );
    const resolvedPath = command
      .replaceAll('"', "")
      .replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN_DIR)
      .trim();
    const rel = path.relative(PLUGIN_DIR, resolvedPath);
    const staysInsidePlugin = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    assertOk(
      staysInsidePlugin,
      `hooks.json command #${i} resolves to a path inside the plugin dir`,
      `resolved=${resolvedPath}`,
    );
    assertOk(
      fs.existsSync(resolvedPath),
      `hooks.json command #${i} resolved path exists on disk`,
      resolvedPath,
    );
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const nameWidth = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.status.padEnd(4)} ${r.name.padEnd(nameWidth)}${r.detail ? `  — ${r.detail}` : ""}`);
}
const passedCount = results.filter((r) => r.status === "PASS").length;
const failedCount = results.filter((r) => r.status === "FAIL").length;
console.log(`\n[validate-plugin] ${passedCount}/${results.length} passed, ${failedCount} failed`);
process.exit(failedCount > 0 ? 1 : 0);
