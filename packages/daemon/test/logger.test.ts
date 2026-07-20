import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  initDaemonLogger,
  resetDaemonLoggerForTests,
  logInfo,
  logError,
  daemonLogPath,
  MAX_LOG_BYTES,
} from "../src/logger.js";

describe("daemon logger", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-logger-"));
    originalHome = process.env.SOJOURN_HOME;
    process.env.SOJOURN_HOME = home;
    resetDaemonLoggerForTests();
  });

  afterEach(() => {
    resetDaemonLoggerForTests();
    if (originalHome === undefined) delete process.env.SOJOURN_HOME;
    else process.env.SOJOURN_HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("daemonLogPath points at $SOJOURN_HOME/daemon.log", () => {
    expect(daemonLogPath()).toBe(path.join(home, "daemon.log"));
  });

  it("before init: mirrors to console but writes NO file (library/test use stays off ~/.sojourn)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("[sojourn] something failed:", new Error("boom"));
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(home, "daemon.log"))).toBe(false);
  });

  it("after init: appends timestamped [level] lines to daemon.log", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    initDaemonLogger();
    logInfo("hello", "world");
    logError("bad thing:", new Error("kapow"));

    const raw = fs.readFileSync(path.join(home, "daemon.log"), "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // ISO timestamp prefix + level tag
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[info\] hello world$/);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[error\] bad thing:/);
    // Error objects log their stack, not "[object Object]"
    expect(raw).toContain("Error: kapow");
    expect(raw).toContain("logger.test.ts");
  });

  it("mirrors to console when not detached", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    initDaemonLogger();
    logInfo("mirrored line");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain("mirrored line");
  });

  it("suppresses console mirroring when SOJOURN_DAEMON_DETACHED=1 (stdout already piped to daemon.log)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.SOJOURN_DAEMON_DETACHED = "1";
    try {
      initDaemonLogger();
      logInfo("not mirrored");
    } finally {
      delete process.env.SOJOURN_DAEMON_DETACHED;
    }
    expect(logSpy).not.toHaveBeenCalled();
    const raw = fs.readFileSync(path.join(home, "daemon.log"), "utf8");
    expect(raw).toContain("not mirrored");
  });

  it("rotates daemon.log to daemon.log.1 when it exceeds the size cap, keeping one generation", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initDaemonLogger();
    const logFile = path.join(home, "daemon.log");
    // Pre-fill past the cap, then log once: the logger must rotate first.
    fs.writeFileSync(logFile, "x".repeat(MAX_LOG_BYTES + 1), "utf8");
    logInfo("fresh after rotation");

    const rotated = path.join(home, "daemon.log.1");
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.statSync(rotated).size).toBe(MAX_LOG_BYTES + 1);
    const fresh = fs.readFileSync(logFile, "utf8");
    expect(fresh).toContain("fresh after rotation");
    expect(fresh.length).toBeLessThan(1000);

    // A second rotation replaces the old generation (only one .1 kept).
    fs.writeFileSync(logFile, "y".repeat(MAX_LOG_BYTES + 1), "utf8");
    logInfo("second rotation");
    expect(fs.readFileSync(rotated, "utf8")[0]).toBe("y");
    expect(fs.existsSync(path.join(home, "daemon.log.2"))).toBe(false);
  });

  it("rotation preserves the inode, so a detached child's inherited stdout fd keeps writing to the live log", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initDaemonLogger();
    const logFile = path.join(home, "daemon.log");
    fs.writeFileSync(logFile, "x".repeat(MAX_LOG_BYTES + 1), "utf8");

    // Stand in for the CLI's detached spawn: an O_APPEND fd handed to the
    // child as stdout/stderr, bound to the INODE, not the path.
    const inodeBefore = fs.statSync(logFile).ino;
    const childFd = fs.openSync(logFile, "a");
    try {
      logInfo("fresh after rotation"); // triggers rotation
      expect(fs.statSync(logFile).ino).toBe(inodeBefore);

      // A rename would have moved this inode to daemon.log.1; a SECOND
      // rotation would then unlink it and the raw crash output below would
      // vanish into a deleted file.
      fs.writeSync(childFd, "V8 OOM banner from the child\n");
      // The child's raw output landed in the LIVE log, not a stale inode.
      expect(fs.readFileSync(logFile, "utf8")).toContain("V8 OOM banner from the child");

      // Append (don't clobber) so the banner is still present when the
      // second rotation copies this generation aside.
      fs.appendFileSync(logFile, "y".repeat(MAX_LOG_BYTES + 1), "utf8");
      logInfo("second rotation");
      fs.writeSync(childFd, "post-second-rotation child output\n");

      expect(fs.statSync(logFile).ino).toBe(inodeBefore);
      const live = fs.readFileSync(logFile, "utf8");
      expect(live).toContain("post-second-rotation child output");
      // The first banner survived into the retained generation.
      expect(fs.readFileSync(path.join(home, "daemon.log.1"), "utf8")).toContain(
        "V8 OOM banner from the child",
      );
    } finally {
      fs.closeSync(childFd);
    }
  });

  it("never throws when the log destination is unwritable", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    initDaemonLogger();
    // Replace the log path with a directory so appendFileSync fails.
    const logFile = path.join(home, "daemon.log");
    fs.rmSync(logFile, { force: true });
    fs.mkdirSync(logFile);
    expect(() => logInfo("cannot land anywhere")).not.toThrow();
  });
});
