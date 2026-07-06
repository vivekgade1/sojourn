#!/usr/bin/env node
import http from "node:http";
import { buildDaemon } from "./wire.js";

const port = Number(process.env.SOJOURN_PORT) || 4177;

const daemon = buildDaemon();
const server = http.createServer();
const app = daemon.createExpressApp(server);
server.on("request", app);

daemon.attachWatcher(server);

// OpenCode SSE capture is OPT-IN (SOJOURN_OPENCODE=1): most environments run
// no OpenCode server at all, and the subscriber would just reconnect-loop.
// The push path (POST /api/hooks/opencode, pinged by plugins/opencode) works
// regardless of this flag.
if (process.env.SOJOURN_OPENCODE === "1") {
  daemon.attachOpenCodeSubscriber(server);
  console.log("[sojourn] OpenCode SSE subscriber enabled (SOJOURN_OPENCODE=1)");
}

server.listen(port, () => {
  console.log(`[sojourn] daemon listening on http://localhost:${port} (ws: /ws)`);
});
