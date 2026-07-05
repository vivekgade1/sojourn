import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
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
  });
});
