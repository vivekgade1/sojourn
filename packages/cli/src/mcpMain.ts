#!/usr/bin/env node
// Standalone entry for the sojourn MCP stdio server. `soj mcp` (program.ts)
// calls runMcpServer directly; this file exists so the server can also be
// spawned as a plain node script (tests bundle it with esbuild, and
// `node dist/mcpMain.js` works after a build).
import { runMcpServer } from "./mcp.js";

runMcpServer().catch((err: unknown) => {
  // stdout belongs to the MCP transport — diagnostics go to stderr only.
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`sojourn mcp server failed: ${message}\n`);
  process.exit(1);
});
