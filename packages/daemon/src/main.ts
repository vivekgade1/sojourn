#!/usr/bin/env node
import http from "node:http";
import { buildDaemon } from "./wire.js";

const port = Number(process.env.SOJOURN_PORT) || 4177;

const daemon = buildDaemon();
const server = http.createServer();
const app = daemon.createExpressApp(server);
server.on("request", app);

daemon.attachWatcher(server);

server.listen(port, () => {
  console.log(`[sojourn] daemon listening on http://localhost:${port} (ws: /ws)`);
});
