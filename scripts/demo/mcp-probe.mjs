#!/usr/bin/env node
/**
 * Demo helper: starts `soj mcp` (the read-only MCP stdio server) as a child
 * process, performs a real MCP handshake over stdio (initialize →
 * notifications/initialized → tools/list), prints the advertised tools, then
 * calls ONE tool to prove the server actually answers.
 *
 * Deliberately narrow: this proves the server starts, speaks MCP, and serves
 * the graph read-only. It does not exercise a real Claude Code MCP client.
 *
 * Env: DEMO_CLI (path to the built CLI main.js), DEMO_CWD (a project dir),
 * plus the usual SOJOURN_PORT/SOJOURN_HOME isolation vars, inherited.
 */
import { spawn } from "node:child_process";

const CLI = process.env.DEMO_CLI;
const CWD = process.env.DEMO_CWD ?? process.cwd();
if (!CLI) {
  console.error("DEMO_CLI is required");
  process.exit(2);
}

const child = spawn(process.execPath, [CLI, "mcp"], {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

let stderr = "";
child.stderr.on("data", (c) => (stderr += c.toString()));

let buffer = "";
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line.length === 0) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let exitCode = 0;
try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "sojourn-demo-probe", version: "0" },
  });
  const info = init.result?.serverInfo ?? {};
  console.log(`initialize ok: server ${info.name ?? "?"} ${info.version ?? "?"}`);
  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  const list = tools.result?.tools ?? [];
  console.log(`tools/list -> ${list.length} tools:`);
  for (const t of list) {
    console.log(`  ${t.name}  —  ${(t.description ?? "").split("\n")[0]}`);
  }

  const called = await request("tools/call", {
    name: "sojourn_flags",
    arguments: {},
  });
  const text = (called.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const head = text.split("\n").slice(0, 4).join("\n");
  console.log("tools/call sojourn_flags -> first lines of result:");
  for (const line of head.split("\n")) console.log(`  ${line}`);
} catch (err) {
  console.error(`MCP probe failed: ${err?.message ?? err}`);
  if (stderr.trim().length > 0) console.error(`server stderr:\n${stderr}`);
  exitCode = 1;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
}
process.exit(exitCode);
