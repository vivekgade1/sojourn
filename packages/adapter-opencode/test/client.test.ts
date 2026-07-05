import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { OpenCodeClient, resolveOpenCodeBaseUrl } from "../src/client.js";

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

describe("OpenCodeClient", () => {
  let server: http.Server;
  let baseUrl: string;
  let requests: RecordedRequest[];
  let responseOverride: { status: number; body: unknown } | null;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsedBody: unknown = undefined;
        if (raw.length > 0) {
          try {
            parsedBody = JSON.parse(raw);
          } catch {
            parsedBody = raw;
          }
        }
        requests.push({ method: req.method ?? "", path: req.url ?? "", body: parsedBody });

        if (responseOverride) {
          res.writeHead(responseOverride.status, { "content-type": "application/json" });
          res.end(JSON.stringify(responseOverride.body));
          return;
        }

        // Default routing mimicking the documented OpenCode routes.
        if (req.method === "GET" && req.url === "/session") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([{ id: "ses_1", title: "Test session" }]));
          return;
        }
        if (req.method === "GET" && req.url === "/session/ses_1/message") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([{ info: { id: "msg_1", role: "user" }, parts: [] }]));
          return;
        }
        if (req.method === "POST" && req.url === "/session/ses_1/revert") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && req.url === "/session/ses_1/fork") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "ses_2" }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    responseOverride = null;
  });

  it("resolveOpenCodeBaseUrl defaults to http://localhost:4096", () => {
    const original = process.env.OPENCODE_URL;
    delete process.env.OPENCODE_URL;
    expect(resolveOpenCodeBaseUrl()).toBe("http://localhost:4096");
    if (original !== undefined) process.env.OPENCODE_URL = original;
  });

  it("resolveOpenCodeBaseUrl honors OPENCODE_URL env var", () => {
    const original = process.env.OPENCODE_URL;
    process.env.OPENCODE_URL = "http://example.test:1234/";
    expect(resolveOpenCodeBaseUrl()).toBe("http://example.test:1234");
    if (original === undefined) delete process.env.OPENCODE_URL;
    else process.env.OPENCODE_URL = original;
  });

  it("listSessions issues GET /session", async () => {
    const client = new OpenCodeClient({ baseUrl });
    const result = await client.listSessions();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].path).toBe("/session");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual([{ id: "ses_1", title: "Test session" }]);
    }
  });

  it("getMessages issues GET /session/:id/message with the id URL-encoded", async () => {
    const client = new OpenCodeClient({ baseUrl });
    const result = await client.getMessages("ses_1");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].path).toBe("/session/ses_1/message");
    expect(result.ok).toBe(true);
  });

  it("getMessages URL-encodes session ids with special characters", async () => {
    const client = new OpenCodeClient({ baseUrl });
    await client.getMessages("ses/with space");
    expect(requests[0].path).toBe("/session/ses%2Fwith%20space/message");
  });

  it("revert issues POST /session/:id/revert with messageID (and partID when given)", async () => {
    const client = new OpenCodeClient({ baseUrl });
    const result = await client.revert("ses_1", "msg_5");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].path).toBe("/session/ses_1/revert");
    expect(requests[0].body).toEqual({ messageID: "msg_5" });
    expect(result.ok).toBe(true);

    await client.revert("ses_1", "msg_6", "prt_9");
    expect(requests[1].body).toEqual({ messageID: "msg_6", partID: "prt_9" });
  });

  it("fork issues POST /session/:id/fork with optional messageID body", async () => {
    const client = new OpenCodeClient({ baseUrl });
    const result = await client.fork("ses_1", "msg_5");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].path).toBe("/session/ses_1/fork");
    expect(requests[0].body).toEqual({ messageID: "msg_5" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ id: "ses_2" });
    }
  });

  it("fork with no messageID sends no body", async () => {
    const client = new OpenCodeClient({ baseUrl });
    await client.fork("ses_1");
    expect(requests[0].body).toBeUndefined();
  });

  it("fails soft (does not throw) and returns ok:false on HTTP error status", async () => {
    responseOverride = { status: 500, body: { error: "boom" } };
    const client = new OpenCodeClient({ baseUrl });
    const result = await client.listSessions();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
  });

  it("fails soft (does not throw) when the server is unreachable", async () => {
    // Port 1 is a reserved/unlikely-to-be-listening port; connecting to it
    // should fail fast with ECONNREFUSED rather than the request ever going through.
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.listSessions()).resolves.toMatchObject({ ok: false });
  });
});
