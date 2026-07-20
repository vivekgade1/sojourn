// `soj mcp` — a local, READ-ONLY MCP (Model Context Protocol) stdio server
// that lets agentic CLIs query the sojourn decision graph.
//
// Design (plan capsule 9, docs/superpowers/plans/2026-07-11-sojourn-v2.md):
// - Every tool call goes through the daemon HTTP API (docs/API.md) — NEVER
//   the SQLite store directly. The daemon stays the single owner of the db.
// - The daemon being down is an EXPECTED state, not a protocol failure:
//   tools answer with friendly error text (an `isError` tool result), so the
//   calling agent sees actionable prose instead of a JSON-RPC error.
// - stdout belongs to the stdio transport. Nothing else may write to it.
// - This module must stay bundleable/spawnable standalone: no runtime import
//   of @sojourn/core (which drags in better-sqlite3). Type-only imports are
//   fine — they are erased at compile time.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ChronoNode, Project, SearchHit, SessionRow, StoredFlag } from "@sojourn/core";
import { encodeNodeId } from "./client.js";
import {
  activeFlags,
  compactHit,
  describeApiError,
  excerpt,
  filterDecisionHits,
} from "./searchFormat.js";

const SERVER_NAME = "sojourn";

const CLI_PACKAGE_NAME = "@sojourn/cli";
/** Reported when the CLI's package.json genuinely cannot be located. */
export const UNKNOWN_VERSION = "0.0.0-unknown";

/**
 * The CLI package's real version, reported to MCP clients in `serverInfo`.
 *
 * Read from packages/cli/package.json rather than hardcoded, so a released
 * `soj` never advertises a stale version. `import.meta.url` keeps this
 * ESM-pure (no `require`), and works from BOTH the built
 * `packages/cli/dist/mcp.js` and the source `packages/cli/src/mcp.ts` under
 * vitest.
 *
 * Walks UP rather than assuming a fixed `../package.json`, and only accepts a
 * package.json whose `name` is `@sojourn/cli` — so it can never silently
 * report some unrelated package's version if this module is relocated or
 * bundled somewhere else on disk. NOTE: this is the CLI package's version,
 * deliberately NOT the repo root's.
 *
 * Fails soft: an unlocatable package.json (e.g. mcp.test.ts's standalone
 * esbuild bundle in a tmpdir) yields UNKNOWN_VERSION instead of throwing —
 * an honest sentinel must never stop the stdio server from starting.
 */
export function readServerVersion(fromUrl: string = import.meta.url): string {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(fromUrl));
  } catch {
    return UNKNOWN_VERSION;
  }
  // Bounded walk: package roots are never deep relative to the module.
  for (let i = 0; i < 10; i++) {
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      if (parsed && typeof parsed === "object") {
        const pkg = parsed as { name?: unknown; version?: unknown };
        if (
          pkg.name === CLI_PACKAGE_NAME &&
          typeof pkg.version === "string" &&
          pkg.version.length > 0
        ) {
          return pkg.version;
        }
      }
    } catch {
      // no package.json here (or unreadable) — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return UNKNOWN_VERSION;
}

const SERVER_VERSION = readServerVersion();

export interface McpServerOptions {
  /** daemon base URL; default resolves like the other soj commands: http://localhost:$SOJOURN_PORT (4177). */
  baseUrl?: string;
  /** cwd used to derive the default project id; defaults to process.cwd(). */
  cwd?: string;
  /** injectable fetch for tests; defaults to global fetch. */
  fetchJson?: (url: string) => Promise<{ status: number; body: unknown }>;
}

/** Same resolution as `defaultDeps()` in program.ts. */
export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://localhost:${env.SOJOURN_PORT ?? "4177"}`;
}

/**
 * Mirrors @sojourn/core paths.ts#projectIdFor (12-hex sha256 of the resolved
 * root). Duplicated deliberately so this module never imports the core
 * package at runtime — keep in sync with core (mcp.test.ts cross-checks the
 * two implementations against each other).
 */
export function projectIdForCwd(cwd: string): string {
  return crypto.createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 12);
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function defaultFetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

const TOOL_DEFINITIONS = [
  {
    name: "sojourn_search",
    description:
      "Read-only full-text search over the sojourn decision graph for this repo: prompts, " +
      "assistant gists, decisions/assumptions/checkpoints, and annotations, plus a " +
      "files-touched index. Returns hits ordered by relevance (best first). " +
      'Use it to answer "why/when did we do X?" from prior sessions.',
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "full-text query, e.g. 'why sqlite over postgres'" },
        file: {
          type: "string",
          description: "optional file path filter — only turns that touched this file",
        },
        project: {
          type: "string",
          description:
            "optional sojourn project id (default: derived from this server's working directory)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "sojourn_decisions",
    description:
      "Read-only list of the durable record for a project: marked decisions, assumptions, " +
      "and checkpoints, plus any nodes carrying active (unresolved, undismissed) flags.",
    inputSchema: {
      type: "object" as const,
      properties: {
        project: {
          type: "string",
          description:
            "optional sojourn project id (default: derived from this server's working directory)",
        },
      },
    },
  },
  {
    name: "sojourn_flags",
    description:
      "Read-only list of active flags (assumption/hallucination findings with evidence) for the " +
      "current project, optionally filtered to one session. `verified` flags are deterministic " +
      "ground-truth checks; `advisory` flags are hedged LLM-critic output.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string", description: "optional session id to filter by" },
      },
    },
  },
  {
    name: "sojourn_node",
    description:
      "Read-only fetch of a single graph node by id (\"<cli>:<uuid>\"), including its flags and " +
      "annotations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nodeId: { type: "string", description: 'node id, e.g. "claude:3f2c…"' },
      },
      required: ["nodeId"],
    },
  },
];

interface GraphResponse {
  project: Project;
  sessions: SessionRow[];
  nodes: ChronoNode[];
}

export function buildMcpServer(opts: McpServerOptions = {}): Server {
  const baseUrl = (opts.baseUrl ?? resolveBaseUrl()).replace(/\/$/, "");
  const cwd = opts.cwd ?? process.cwd();
  const fetchJson = opts.fetchJson ?? defaultFetchJson;

  const daemonDown = (): ToolResult =>
    fail(
      `sojourn daemon is not reachable at ${baseUrl} — it does not appear to be running. ` +
        "Start it with `soj start` and retry. (Sojourn is local-only: this tool never talks " +
        "to anything but the local daemon.)",
    );

  const httpError = (status: number, body: unknown): ToolResult =>
    fail(`sojourn daemon answered HTTP ${status}: ${describeApiError(body)}`);

  async function get(pathname: string): Promise<{ status: number; body: unknown } | null> {
    try {
      return await fetchJson(`${baseUrl}${pathname}`);
    } catch {
      return null; // network-level failure — daemon down
    }
  }

  async function toolSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = args.query;
    if (typeof query !== "string" || query.trim() === "") {
      return fail("sojourn_search requires a non-empty `query` string.");
    }
    const projectId =
      typeof args.project === "string" && args.project !== "" ? args.project : projectIdForCwd(cwd);
    const params = new URLSearchParams({ projectId, q: query });
    if (typeof args.file === "string" && args.file !== "") params.set("file", args.file);
    const res = await get(`/api/search?${params.toString()}`);
    if (res === null) return daemonDown();
    if (res.status !== 200) return httpError(res.status, res.body);
    const hits = ((res.body as { hits?: SearchHit[] } | undefined)?.hits ?? []).map(compactHit);
    if (hits.length === 0) {
      return ok(
        `no matches for "${query}" in project ${projectId}. sojourn only knows what the local ` +
          "daemon captured — try a broader query, or sojourn_decisions to list marks and flags.",
      );
    }
    return ok(JSON.stringify({ projectId, hits }, null, 2));
  }

  async function toolDecisions(args: Record<string, unknown>): Promise<ToolResult> {
    const projectId =
      typeof args.project === "string" && args.project !== "" ? args.project : projectIdForCwd(cwd);
    const params = new URLSearchParams({ projectId });
    const res = await get(`/api/search?${params.toString()}`);
    if (res === null) return daemonDown();
    if (res.status !== 200) return httpError(res.status, res.body);
    const hits = (res.body as { hits?: SearchHit[] } | undefined)?.hits ?? [];
    const decisions = filterDecisionHits(hits).map((h) => ({
      ...compactHit(h),
      flags: activeFlags(h.node).map((f) => ({
        kind: f.kind,
        tier: f.tier,
        confidence: f.confidence,
        evidence: excerpt(f.evidence, 160),
      })),
    }));
    if (decisions.length === 0) {
      return ok(
        `no decisions, assumptions, checkpoints, or flagged turns recorded for project ` +
          `${projectId} yet. \`soj mark\` creates one.`,
      );
    }
    return ok(JSON.stringify({ projectId, decisions }, null, 2));
  }

  async function toolFlags(args: Record<string, unknown>): Promise<ToolResult> {
    const sessionId = typeof args.sessionId === "string" && args.sessionId !== "" ? args.sessionId : null;
    const projectId = projectIdForCwd(cwd);
    const res = await get(`/api/projects/${encodeNodeId(projectId)}/graph`);
    if (res === null) return daemonDown();
    if (res.status !== 200) return httpError(res.status, res.body);
    const nodes = (res.body as GraphResponse | undefined)?.nodes ?? [];
    const flags: Array<StoredFlag & { nodeId: string }> = [];
    for (const node of nodes) {
      if (sessionId !== null && node.sessionId !== sessionId) continue;
      for (const flag of activeFlags(node)) {
        flags.push({ ...flag, nodeId: node.id });
      }
    }
    if (flags.length === 0) {
      return ok(
        sessionId === null
          ? `no active flags in project ${projectId}.`
          : `no active flags in session ${sessionId} (project ${projectId}).`,
      );
    }
    return ok(
      JSON.stringify(
        {
          projectId,
          sessionId,
          flags: flags.map((f) => ({
            nodeId: f.nodeId,
            kind: f.kind,
            tier: f.tier,
            confidence: f.confidence,
            evidence: f.evidence,
            createdAt: f.createdAt,
            ...(f.suppressedCount ? { suppressedCount: f.suppressedCount } : {}),
          })),
        },
        null,
        2,
      ),
    );
  }

  async function toolNode(args: Record<string, unknown>): Promise<ToolResult> {
    const nodeId = args.nodeId;
    if (typeof nodeId !== "string" || nodeId.trim() === "") {
      return fail("sojourn_node requires a non-empty `nodeId` string.");
    }
    const res = await get(`/api/nodes/${encodeNodeId(nodeId)}`);
    if (res === null) return daemonDown();
    if (res.status === 404) {
      return fail(`node ${nodeId} was not found in the sojourn graph.`);
    }
    if (res.status !== 200) return httpError(res.status, res.body);
    return ok(JSON.stringify(res.body, null, 2));
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    switch (request.params.name) {
      case "sojourn_search":
        return await toolSearch(args);
      case "sojourn_decisions":
        return await toolDecisions(args);
      case "sojourn_flags":
        return await toolFlags(args);
      case "sojourn_node":
        return await toolNode(args);
      default:
        return fail(
          `unknown tool "${request.params.name}" — this server exposes ` +
            TOOL_DEFINITIONS.map((t) => t.name).join(", "),
        );
    }
  });

  return server;
}

/**
 * Connects the server to stdio and resolves when the transport closes
 * (i.e. the MCP client disconnects / stdin ends).
 */
export async function runMcpServer(opts: McpServerOptions = {}): Promise<void> {
  const server = buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
}
