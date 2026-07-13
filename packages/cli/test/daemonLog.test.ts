import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { buildProgram, defaultDeps, type ProgramDeps } from "../src/program.js";
import { tailLogLines, daemonLogPath, writePid } from "../src/daemonCtl.js";

function makeDeps(overrides: Partial<ProgramDeps>): {
  deps: ProgramDeps;
  out: string[];
  err: string[];
  exitCodes: number[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const exitCodes: number[] = [];
  const deps = defaultDeps({
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    exit: (code) => {
      exitCodes.push(code);
    },
    ...overrides,
  });
  return { deps, out, err, exitCodes };
}

function run(program: Command, args: string[]): Promise<void> {
  return program.parseAsync(["node", "soj", ...args]);
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe("daemon.log crash forensics", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sojourn-daemonlog-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe("tailLogLines", () => {
    it("returns [] when daemon.log does not exist", () => {
      expect(tailLogLines(home, 5)).toEqual([]);
    });

    it("returns the last n non-empty lines", () => {
      const lines = Array.from({ length: 8 }, (_, i) => `line-${i + 1}`);
      writeFileSync(daemonLogPath(home), lines.join("\n") + "\n", "utf8");
      expect(tailLogLines(home, 3)).toEqual(["line-6", "line-7", "line-8"]);
      expect(tailLogLines(home, 99)).toEqual(lines);
    });
  });

  describe("soj start failure", () => {
    it("prints the last 10 daemon.log lines and a pointer when health never becomes ready", async () => {
      const logLines = Array.from({ length: 12 }, (_, i) => `log-${i + 1}`);
      writeFileSync(daemonLogPath(home), logLines.join("\n") + "\n", "utf8");
      const spawnDaemon = vi.fn().mockReturnValue({ pid: 4343, unref: () => {} });
      const { deps, err, exitCodes } = makeDeps({
        baseUrl: "http://127.0.0.1:1", // nothing listens here
        sojournHome: home,
        spawnDaemon,
        fetchJson: async () => ({ status: 404, body: undefined }),
        healthTimeoutMs: 100,
        healthIntervalMs: 20,
      });
      const program = buildProgram(deps);
      await run(program, ["start"]);

      expect(exitCodes).toEqual([1]);
      const text = err.join("\n");
      expect(text).toContain("did not become healthy");
      // last 10 lines: log-3 .. log-12, not the first two
      expect(text).toContain("log-3");
      expect(text).toContain("log-12");
      expect(text).not.toContain("log-2");
      expect(text).toContain(daemonLogPath(home));
    });
  });

  describe("soj status with a dead pidfile process", () => {
    it("says the daemon is dead and prints the last 5 daemon.log lines", async () => {
      writePid(home, 999999); // macOS/linux pid space makes this ESRCH-dead
      const logLines = Array.from({ length: 7 }, (_, i) => `tail-${i + 1}`);
      writeFileSync(daemonLogPath(home), logLines.join("\n") + "\n", "utf8");
      const { deps, out } = makeDeps({ baseUrl: "http://127.0.0.1:1", sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["status"]);

      const text = out.join("\n");
      expect(text).toContain("stopped");
      expect(text).toContain("999999");
      expect(text).toMatch(/dead|crashed/);
      // last 5 lines: tail-3 .. tail-7, not the first two
      expect(text).toContain("tail-3");
      expect(text).toContain("tail-7");
      expect(text).not.toContain("tail-2");
      expect(text).toContain(daemonLogPath(home));
    });

    it("still reports plain stopped when there is no pidfile at all", async () => {
      const { deps, out } = makeDeps({ baseUrl: "http://127.0.0.1:1", sojournHome: home });
      const program = buildProgram(deps);
      await run(program, ["status"]);
      expect(out.join("\n")).toContain("stopped");
    });
  });

  describe("default spawnDaemon", () => {
    it("pipes child stdout+stderr into daemon.log and marks the child detached", async () => {
      const entry = join(home, "fake-daemon.js");
      writeFileSync(
        entry,
        'console.log("child-stdout detached=" + (process.env.SOJOURN_DAEMON_DETACHED ?? "unset"));\n' +
          'console.error("child-stderr-marker");\n',
        "utf8",
      );
      const deps = defaultDeps({ sojournHome: home });
      const child = deps.spawnDaemon(entry, { ...process.env });
      expect(child.pid).toBeGreaterThan(0);

      const logFile = daemonLogPath(home);
      const landed = await waitFor(() => {
        if (!existsSync(logFile)) return false;
        const raw = readFileSync(logFile, "utf8");
        return raw.includes("child-stdout") && raw.includes("child-stderr-marker");
      });
      expect(landed).toBe(true);
      const raw = readFileSync(logFile, "utf8");
      // early-crash output (pre-logger) lands in the same daemon.log ...
      expect(raw).toContain("child-stderr-marker");
      // ... and the daemon suppresses console mirroring when detached
      expect(raw).toContain("child-stdout detached=1");
    });
  });
});
