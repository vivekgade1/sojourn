#!/usr/bin/env node
import http from "node:http";
import { createRequire } from "node:module";
import { sojournHome } from "@sojourn/core";
import { buildDaemon } from "./wire.js";
import { installProcessGuards } from "./guards.js";
import { initDaemonLogger, logError, logInfo } from "./logger.js";
import type { WatcherHandle } from "./watcher.js";

const port = Number(process.env.SOJOURN_PORT) || 4177;

// File logging + crash guards FIRST: everything after this line lands in
// $SOJOURN_HOME/daemon.log, and no stray rejection/exception can silently
// kill the process (capture is passive — one bad transcript/batch must
// never take the daemon down; only a crash storm exits, code 1).
const logFile = initDaemonLogger();
installProcessGuards();

/** Monorepo root package.json version (dist/main.js -> ../../../package.json),
 * falling back to the daemon's own package.json, then "0.0.0". */
function readVersion(): string {
  const require = createRequire(import.meta.url);
  for (const rel of ["../../../package.json", "../package.json"]) {
    try {
      const pkg = require(rel) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try the next candidate
    }
  }
  return "0.0.0";
}

logInfo(
  `[sojourn] daemon starting: pid=${process.pid} version=${readVersion()} ` +
    `node=${process.version} SOJOURN_HOME=${sojournHome()} port=${port} log=${logFile}`,
);

// Startup is the ONE phase where errors are fatal: a daemon whose DB never
// opened or whose port never bound has nothing to keep alive — log + exit 1
// (the CLI tails daemon.log on a failed `soj start`).
let server: http.Server;
let watcherHandle: WatcherHandle | null = null;
try {
  const daemon = buildDaemon();
  server = http.createServer();
  const app = daemon.createExpressApp(server);
  server.on("request", app);

  watcherHandle = daemon.attachWatcher(server);

  // OpenCode SSE capture is OPT-IN (SOJOURN_OPENCODE=1): most environments run
  // no OpenCode server at all, and the subscriber would just reconnect-loop.
  // The push path (POST /api/hooks/opencode, pinged by plugins/opencode) works
  // regardless of this flag.
  if (process.env.SOJOURN_OPENCODE === "1") {
    daemon.attachOpenCodeSubscriber(server);
    logInfo("[sojourn] OpenCode SSE subscriber enabled (SOJOURN_OPENCODE=1)");
  }
} catch (err) {
  logError("[sojourn] fatal: daemon startup failed (DB open / wiring):", err);
  process.exit(1);
}

let listening = false;
server.on("error", (err) => {
  if (!listening) {
    // e.g. EADDRINUSE / EACCES on the initial bind — fatal by design.
    logError(`[sojourn] fatal: listen on port ${port} failed:`, err);
    process.exit(1);
  }
  logError("[sojourn] http server error:", err);
});

// Loopback only: the API now carries write routes (harvest/rewind) and the
// trust model is single-user localhost — never expose them to the LAN.
server.listen(port, "127.0.0.1", () => {
  listening = true;
  logInfo(`[sojourn] daemon listening on http://localhost:${port} (ws: /ws)`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo(`[sojourn] received ${signal} — shutting down`);
  try {
    void watcherHandle?.close().catch(() => {});
  } catch {
    // never let cleanup block shutdown
  }
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  // Open WS/SSE connections can hold close() forever — don't hang shutdown.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
