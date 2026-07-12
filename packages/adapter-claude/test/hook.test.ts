import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hookScriptPath = path.join(__dirname, "..", "dist", "hooks", "postToolUse.js");

const HOOK_PAYLOAD = {
  session_id: "session-abc",
  transcript_path: "/home/user/.claude/projects/foo/session-abc.jsonl",
  cwd: "/repo/project",
  hook_event_name: "PostToolUse",
};

/** Finds a free TCP port by asking the OS to bind an ephemeral one and releasing it. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
    srv.on("error", reject);
  });
}

function runHook(
  input: string,
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    child.stdin.write(input);
    child.stdin.end();
  });
}

describe("postToolUse hook script (compiled)", () => {
  describe("with a stub daemon server running", () => {
    let server: Server;
    let port: number;
    let capturedBodies: string[] = [];

    beforeAll(async () => {
      port = await findFreePort();
      capturedBodies = [];
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          capturedBodies.push(body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      await new Promise<void>((resolve) => server.listen(port, resolve));
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("exits 0 and POSTs the hook payload to the daemon", async () => {
      const result = await runHook(JSON.stringify(HOOK_PAYLOAD), {
        SOJOURN_PORT: String(port),
      });
      expect(result.code).toBe(0);
      expect(capturedBodies).toHaveLength(1);
      const parsed = JSON.parse(capturedBodies[0]);
      expect(parsed).toEqual(HOOK_PAYLOAD);
    });
  });

  describe("with no daemon server running", () => {
    it("exits 0 even though the POST fails (connection refused)", async () => {
      // Use a port we just verified is free (no listener bound).
      const port = await findFreePort();
      const result = await runHook(JSON.stringify(HOOK_PAYLOAD), {
        SOJOURN_PORT: String(port),
      });
      expect(result.code).toBe(0);
    });
  });

  describe("malformed / edge-case stdin", () => {
    it("exits 0 when stdin is not valid JSON", async () => {
      const port = await findFreePort();
      const result = await runHook("not json at all {{{", {
        SOJOURN_PORT: String(port),
      });
      expect(result.code).toBe(0);
    });

    it("exits 0 when stdin is empty", async () => {
      const port = await findFreePort();
      const result = await runHook("", { SOJOURN_PORT: String(port) });
      expect(result.code).toBe(0);
    });

    it("exits 0 within ~4s when stdin is written but never closed (hangs open)", async () => {
      const port = await findFreePort();
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [hookScriptPath], {
            env: { ...process.env, SOJOURN_PORT: String(port) },
            stdio: ["pipe", "pipe", "pipe"],
          });

          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d.toString()));
          child.stderr.on("data", (d) => (stderr += d.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));

          // Write a partial, incomplete JSON payload and deliberately never
          // call child.stdin.end() — the caller (Claude Code) is not
          // guaranteed to close stdin, and this hook must not hang forever
          // waiting for EOF.
          child.stdin.write('{"session_id": "abc", "incomplete":');
        },
      );

      expect(result.code).toBe(0);
    }, 4500);
  });
});

const STOP_PAYLOAD = {
  session_id: "session-abc",
  transcript_path: "/home/user/.claude/projects/foo/session-abc.jsonl",
  cwd: "/repo/project",
  hook_event_name: "Stop",
};

/** Starts an ephemeral HTTP server and resolves once it's bound, port included. */
function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({ server, port: address.port });
      } else {
        reject(new Error("could not determine bound port"));
      }
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Like `runHook`, but the child's stdout is drained by a deliberately
 * SLOW consumer instead of the normal always-flowing `.on("data", ...)`
 * used elsewhere in this file. `child.stdout` is left in paused mode (no
 * `.resume()`, no `"data"` listener) and pulled from on a timer, so the
 * hook process is writing into a pipe that a downstream reader (like
 * Claude Code's own hook-stdout consumption) isn't draining as fast as it
 * possibly could.
 *
 * This exercises the same code path a genuinely backpressured pipe would
 * (the write must actually complete — via callback and, if needed,
 * `"drain"` — before the hook is allowed to call `process.exit()`), so it
 * guards against a regression back to synchronous fire-and-forget
 * `process.stdout.write()` calls racing an immediate `process.exit()`.
 * Because data already pulled into the Readable's internal buffer survives
 * past the child's `"close"` event, a final drain pass after close is
 * required to account for every byte.
 */
function runHookSlowReader(
  input: string,
  env: Record<string, string | undefined>,
  readIntervalMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookScriptPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let stderr = "";
    let closed = false;
    let exitCode: number | null = null;

    const drain = () => {
      let chunk: Buffer | string | null;
      while ((chunk = child.stdout.read()) !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    };
    // A paused Readable only starts pulling bytes off the underlying fd
    // once something asks it to (a "readable"/"data" listener, or a
    // `.read()` call) — attaching this listener immediately is what starts
    // that flow. Without it, if the child runs its whole lifecycle and
    // exits before our first throttled `drain()` tick below, Node tears
    // down the child's stdio on exit having never read the pipe at all,
    // and the data is lost before `drain()` gets its first chance to run.
    // The listener itself does nothing — throttling *how often we pull
    // already-buffered data out* (via the interval below) is what makes
    // this a slow reader, not delaying when reading starts.
    child.stdout.on("readable", () => {});
    const readTimer = setInterval(drain, readIntervalMs);
    let finishTimer: NodeJS.Timeout;

    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearInterval(readTimer);
      clearInterval(finishTimer);
      reject(err);
    });
    child.on("close", (code) => {
      closed = true;
      exitCode = code;
    });

    finishTimer = setInterval(() => {
      if (!closed) return;
      drain(); // final flush of anything already pulled into the internal buffer
      clearInterval(readTimer);
      clearInterval(finishTimer);
      resolve({ code: exitCode, stdout: Buffer.concat(chunks).toString("utf8"), stderr });
    }, 10);

    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Stub daemon covering both routes the hook talks to: the existing
 * `POST /api/hooks/claude` (always 200s immediately) and
 * `GET /api/sessions/:id/turn-flags` (response shaped by the options
 * below). `getDelayMs` lets a test simulate a slow/hanging daemon on just
 * the flags route without affecting the POST route.
 */
function turnFlagsServer(opts: {
  status?: number;
  body?: unknown; // JSON.stringify'd; omit for an empty body
  raw?: string; // overrides `body` with a literal (possibly non-JSON) string
  getDelayMs?: number;
}) {
  const { status = 200, body, raw, getDelayMs = 0 } = opts;
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/api/hooks/claude") {
      let received = "";
      req.on("data", (chunk) => (received += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      // Silence unused-var lint without changing capture semantics.
      void received;
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/sessions/") && req.url.includes("/turn-flags")) {
      const send = () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : "");
      };
      if (getDelayMs > 0) {
        setTimeout(send, getDelayMs);
      } else {
        send();
      }
      return;
    }
    res.writeHead(404);
    res.end();
  };
}

describe("postToolUse hook: terminal flag delivery (SOJOURN_HOOK_FLAGS)", () => {
  it("prints each returned line prefixed 'Sojourn: ' when env set, event is Stop, and server responds", async () => {
    const { server, port } = await startServer(
      turnFlagsServer({ body: { lines: ["edit-claim mismatch in foo.ts", "unverifiable test claim"] } }),
    );
    try {
      const result = await runHook(JSON.stringify(STOP_PAYLOAD), {
        SOJOURN_PORT: String(port),
        SOJOURN_HOOK_FLAGS: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("Sojourn: edit-claim mismatch in foo.ts\nSojourn: unverifiable test claim\n");
    } finally {
      await closeServer(server);
    }
  });

  it("stays silent when SOJOURN_HOOK_FLAGS is not set, even on a Stop event with flags available", async () => {
    const { server, port } = await startServer(turnFlagsServer({ body: { lines: ["should not appear"] } }));
    try {
      const result = await runHook(JSON.stringify(STOP_PAYLOAD), {
        SOJOURN_PORT: String(port),
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await closeServer(server);
    }
  });

  it("stays silent on non-Stop events even when the env var is set", async () => {
    const postToolUsePayload = { ...STOP_PAYLOAD, hook_event_name: "PostToolUse" };
    const { server, port } = await startServer(turnFlagsServer({ body: { lines: ["should not appear"] } }));
    try {
      const result = await runHook(JSON.stringify(postToolUsePayload), {
        SOJOURN_PORT: String(port),
        SOJOURN_HOOK_FLAGS: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await closeServer(server);
    }
  });

  it("stays silent and exits 0 when the daemon is down", async () => {
    const port = await findFreePort(); // nothing bound
    const started = Date.now();
    const result = await runHook(JSON.stringify(STOP_PAYLOAD), {
      SOJOURN_PORT: String(port),
      SOJOURN_HOOK_FLAGS: "1",
    });
    const elapsedMs = Date.now() - started;
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    // Well under the 3s hard-exit ceiling: connection-refused failures on
    // both the POST and the GET should fail fast, not wait out a timeout.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("stays silent and exits 0 within the added-latency budget when the flags route is slow", async () => {
    // The GET response arrives well after FLAGS_TIMEOUT_MS (500ms); the
    // hook must abort and move on rather than wait for it.
    const { server, port } = await startServer(
      turnFlagsServer({ body: { lines: ["too late"] }, getDelayMs: 1500 }),
    );
    try {
      const started = Date.now();
      const result = await runHook(JSON.stringify(STOP_PAYLOAD), {
        SOJOURN_PORT: String(port),
        SOJOURN_HOOK_FLAGS: "1",
      });
      const elapsedMs = Date.now() - started;
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      // POST budget (500ms, but this server answers it immediately) +
      // flags budget (500ms) + generous scheduling slack — well short of
      // the 1500ms the slow response is delayed by.
      expect(elapsedMs).toBeLessThan(1200);
    } finally {
      await closeServer(server);
    }
  }, 4500);

  it("stays silent and exits 0 when turn-flags returns a non-200 status", async () => {
    const { server, port } = await startServer(turnFlagsServer({ status: 500, body: { error: "boom" } }));
    try {
      const result = await runHook(JSON.stringify(STOP_PAYLOAD), {
        SOJOURN_PORT: String(port),
        SOJOURN_HOOK_FLAGS: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await closeServer(server);
    }
  });

  it("stays silent and exits 0 when turn-flags returns an empty lines array", async () => {
    const { server, port } = await startServer(turnFlagsServer({ body: { lines: [] } }));
    try {
      const result = await runHook(JSON.stringify(STOP_PAYLOAD), {
        SOJOURN_PORT: String(port),
        SOJOURN_HOOK_FLAGS: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await closeServer(server);
    }
  });

  it("stays silent and exits 0 when turn-flags returns malformed (non-JSON) body", async () => {
    const { server, port } = await startServer(turnFlagsServer({ raw: "not json at all {{{" }));
    try {
      const result = await runHook(JSON.stringify(STOP_PAYLOAD), {
        SOJOURN_PORT: String(port),
        SOJOURN_HOOK_FLAGS: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await closeServer(server);
    }
  });

  it("prints verified lines but defensively drops any line mentioning 'advisory'", async () => {
    const { server, port } = await startServer(
      turnFlagsServer({
        body: { lines: ["edit-claim mismatch in foo.ts", "Advisory: this is just a hunch"] },
      }),
    );
    try {
      const result = await runHook(JSON.stringify(STOP_PAYLOAD), {
        SOJOURN_PORT: String(port),
        SOJOURN_HOOK_FLAGS: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("Sojourn: edit-claim mismatch in foo.ts\n");
      expect(result.stdout).not.toContain("advisory");
      expect(result.stdout).not.toContain("Advisory");
    } finally {
      await closeServer(server);
    }
  });

  it("delivers every flag line byte-complete to a slow-reading stdout consumer", async () => {
    // A realistic per-turn payload (packages/core/src/flags/budget.ts caps
    // verified flags at DEFAULT_VERIFIED_BUDGET=3 plus room for a digest
    // line) — not an inflated payload manufactured just to strain a pipe
    // buffer, so a pass here is an honest signal about real usage.
    const flagLines = [
      "edit-claim mismatch: claimed to modify packages/core/src/foo.ts but the diff touched packages/core/src/bar.ts",
      "package-hallucination: 'left-pad-ultra' is not a published npm package",
      "unverifiable test claim: no test run was recorded to support \"all tests pass\"",
      "symbol-ref not found: `computeShadowHash` does not exist in packages/core/src/snapshot/shadowSnapshotter.ts",
    ];
    const expectedStdout = flagLines.map((line) => `Sojourn: ${line}\n`).join("");

    const { server, port } = await startServer(turnFlagsServer({ body: { lines: flagLines } }));
    try {
      // Read whatever is available on the pipe only once every 20ms,
      // instead of draining it as fast as possible — a downstream
      // consumer that is slower than the hook's writes.
      const result = await runHookSlowReader(
        JSON.stringify(STOP_PAYLOAD),
        { SOJOURN_PORT: String(port), SOJOURN_HOOK_FLAGS: "1" },
        20,
      );
      expect(result.code).toBe(0);
      // Byte-complete: no line dropped or truncated by an unflushed pipe
      // buffer at process.exit() time.
      expect(result.stdout).toBe(expectedStdout);
      expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(flagLines.length);
    } finally {
      await closeServer(server);
    }
  }, 4500);
});
