// `soj mcp` — stdio MCP server tests (plan capsule 9).
//
// The server is esbuild-bundled from src/mcpMain.ts into a self-contained
// script (mcp.ts is deliberately free of native deps, so the bundle needs no
// node_modules at runtime), spawned as a real child process over stdio pipes,
// and driven with the official MCP client. The daemon is a stub HTTP server;
// SOJOURN_PORT in the child's env points at it, matching how every other soj
// command resolves the daemon.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectIdFor } from "@sojourn/core";
import { projectIdForCwd } from "../src/mcp.js";
import { StubDaemon, closedPort } from "./helpers/stubDaemon.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TextToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe("soj mcp (stdio server)", () => {
  let bundleDir: string;
  let bundlePath: string;
  let childCwd: string;
  let stub: StubDaemon;
  let client: Client;

  async function connectClient(env: Record<string, string>): Promise<{ client: Client; close: () => Promise<void> }> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundlePath],
      env: { ...getDefaultEnvironment(), ...env },
      cwd: childCwd,
    });
    const c = new Client({ name: "sojourn-mcp-test", version: "0.0.0" });
    await c.connect(transport);
    return { client: c, close: () => c.close() };
  }

  beforeAll(async () => {
    bundleDir = mkdtempSync(join(tmpdir(), "sojourn-mcp-bundle-"));
    childCwd = realpathSync(mkdtempSync(join(tmpdir(), "sojourn-mcp-cwd-")));
    bundlePath = join(bundleDir, "mcp-server.mjs");

    await build({
      entryPoints: [resolve(__dirname, "../src/mcpMain.ts")],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      logLevel: "silent",
      // CJS deps inside the SDK graph may reference require()
      banner: {
        js: "import { createRequire as __sojCreateRequire } from 'node:module'; const require = __sojCreateRequire(import.meta.url);",
      },
    });

    stub = new StubDaemon();
    await stub.listen();

    const connected = await connectClient({ SOJOURN_PORT: String(stub.port) });
    client = connected.client;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await stub?.close();
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(childCwd, { recursive: true, force: true });
  });

  it("completes the initialize handshake and identifies as sojourn", () => {
    const serverInfo = client.getServerVersion();
    expect(serverInfo?.name).toBe("sojourn");
    expect(serverInfo?.version).toBeTruthy();
  });

  it("tools/list exposes exactly the four read-only tools with schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "sojourn_decisions",
      "sojourn_flags",
      "sojourn_node",
      "sojourn_search",
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
    }

    const search = tools.find((t) => t.name === "sojourn_search")!;
    const searchSchema = search.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(searchSchema.properties).sort()).toEqual(["file", "project", "query"]);
    expect(searchSchema.required).toEqual(["query"]);

    const nodeTool = tools.find((t) => t.name === "sojourn_node")!;
    const nodeSchema = nodeTool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
    expect(Object.keys(nodeSchema.properties)).toEqual(["nodeId"]);
    expect(nodeSchema.required).toEqual(["nodeId"]);

    const decisions = tools.find((t) => t.name === "sojourn_decisions")!;
    expect(Object.keys((decisions.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual([
      "project",
    ]);
    const flags = tools.find((t) => t.name === "sojourn_flags")!;
    expect(Object.keys((flags.inputSchema as { properties: Record<string, unknown> }).properties)).toEqual([
      "sessionId",
    ]);
  });

  it("tools/call sojourn_search hits the stub daemon's /api/search and returns compact hits", async () => {
    stub.requests.length = 0;
    stub.on("GET", "/api/search", () => ({
      status: 200,
      body: {
        hits: [
          {
            node: {
              id: "claude:node-1",
              parentId: null,
              kind: "decision",
              cli: "claude",
              sessionId: "s1",
              projectId: "p1",
              timestamp: "2026-07-01T00:00:00.000Z",
              snapshotRef: null,
              label: "chose the shadow repo design",
              summary: "",
              content: {},
              meta: { nativeUuid: "node-1" },
            },
            score: 11.5,
            snippet: "…one shadow git repo per project…",
          },
        ],
      },
    }));

    const result = (await client.callTool({
      name: "sojourn_search",
      arguments: { query: "shadow repo", file: "packages/core/src/snapshot/shadowSnapshotter.ts", project: "p1" },
    })) as TextToolResult;

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("claude:node-1");
    expect(text).toContain("chose the shadow repo design");
    expect(text).toContain("one shadow git repo per project");

    const req = stub.requests.find((r) => r.url.startsWith("/api/search"));
    expect(req).toBeDefined();
    const params = new URLSearchParams(req!.url.split("?")[1]);
    expect(params.get("q")).toBe("shadow repo");
    expect(params.get("projectId")).toBe("p1");
    expect(params.get("file")).toBe("packages/core/src/snapshot/shadowSnapshotter.ts");
  });

  it("derives the default project id from the server's cwd exactly like @sojourn/core projectIdFor", async () => {
    // Cross-check of the deliberately duplicated hash in mcp.ts against core.
    expect(projectIdForCwd(childCwd)).toBe(projectIdFor(childCwd));

    stub.requests.length = 0;
    stub.on("GET", "/api/search", () => ({ status: 200, body: { hits: [] } }));
    const result = (await client.callTool({
      name: "sojourn_search",
      arguments: { query: "anything" },
    })) as TextToolResult;
    expect(result.isError).toBeFalsy(); // zero hits is a friendly text answer, not an error

    const req = stub.requests.find((r) => r.url.startsWith("/api/search"));
    const params = new URLSearchParams(req!.url.split("?")[1]);
    expect(params.get("projectId")).toBe(projectIdFor(childCwd));
  });

  it("tools/call sojourn_node URL-encodes the ':' in node ids", async () => {
    stub.on("GET", "/api/nodes/claude%3Anode-9", () => ({
      status: 200,
      body: { id: "claude:node-9", kind: "assistant", summary: "the node", flags: [], annotations: [] },
    }));

    const result = (await client.callTool({
      name: "sojourn_node",
      arguments: { nodeId: "claude:node-9" },
    })) as TextToolResult;

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("claude:node-9");
    expect(stub.requests.some((r) => r.url === "/api/nodes/claude%3Anode-9")).toBe(true);
  });

  it("daemon down: tools answer with friendly error text, not a protocol error", async () => {
    const deadPort = await closedPort();
    const { client: downClient, close } = await connectClient({ SOJOURN_PORT: String(deadPort) });
    try {
      // callTool resolving (not rejecting) proves this is a tool-level result,
      // not a JSON-RPC protocol error.
      const result = (await downClient.callTool({
        name: "sojourn_flags",
        arguments: {},
      })) as TextToolResult;

      expect(result.isError).toBe(true);
      const text = result.content[0].text;
      expect(text).toContain("sojourn daemon is not reachable");
      expect(text).toContain("soj start");
      expect(text).not.toContain("ECONNREFUSED");
      expect(text).not.toContain("fetch failed");

      // the server itself stays healthy after a failed daemon call
      const { tools } = await downClient.listTools();
      expect(tools).toHaveLength(4);
    } finally {
      await close();
    }
  });
});
