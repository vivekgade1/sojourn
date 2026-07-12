// Shared stub daemon for CLI tests — same shape as the inline StubServer in
// cli.test.ts, plus dual-stack listening so a SPAWNED child process reaching
// the daemon via `http://localhost:<port>` (mcp.test.ts) connects regardless
// of whether localhost resolves to ::1 or 127.0.0.1 on this machine.
import http, { type IncomingMessage, type ServerResponse } from "node:http";

export type RouteHandler = (req: IncomingMessage, body: unknown) => { status: number; body: unknown };

export class StubDaemon {
  server: http.Server;
  port = 0;
  requests: Array<{ method: string; url: string; body: unknown }> = [];
  routes = new Map<string, RouteHandler>();

  constructor() {
    this.server = http.createServer((req, res) => void this.handle(req, res));
  }

  on(method: string, pattern: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${pattern}`, handler);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = undefined;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    this.requests.push({ method, url, body });

    const pathOnly = url.split("?")[0];
    const handler = this.routes.get(`${method} ${pathOnly}`);
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no stub route for ${method} ${url}` }));
      return;
    }
    const result = handler(req, body);
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.body === undefined ? "" : JSON.stringify(result.body));
  }

  /** Listens without a host argument → dual-stack (:: with v4-mapped) where available. */
  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, () => resolve());
    });
    const addr = this.server.address();
    if (addr && typeof addr === "object") this.port = addr.port;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /** For in-process CLI deps (program.ts) — pin to IPv4 loopback like cli.test.ts does. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }
}

/** Grabs a port that is (almost certainly) connection-refused: bind, read, close. */
export async function closedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, () => resolve()));
  const addr = probe.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
  return port;
}
