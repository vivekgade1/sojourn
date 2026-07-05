import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { isPathInsideDir, buildDaemon } from "../src/wire.js";

describe("isPathInsideDir", () => {
  it("is true for a path strictly inside the directory", () => {
    expect(isPathInsideDir("/home/user/.claude/projects/foo/bar.jsonl", "/home/user/.claude/projects")).toBe(
      true,
    );
  });

  it("is true for the directory itself with a trailing segment", () => {
    expect(isPathInsideDir("/base/dir/file.jsonl", "/base/dir")).toBe(true);
  });

  it("is false for a path outside the directory (e.g. /etc/passwd)", () => {
    expect(isPathInsideDir("/etc/passwd", "/home/user/.claude/projects")).toBe(false);
  });

  it("is false for a sibling directory that merely shares a string prefix", () => {
    // /home/user/.claude/projects-evil/x should NOT count as inside
    // /home/user/.claude/projects (a naive, non-path.sep-aware prefix
    // check would incorrectly treat this as inside).
    expect(isPathInsideDir("/home/user/.claude/projects-evil/x", "/home/user/.claude/projects")).toBe(
      false,
    );
  });

  it("resolves relative segments (e.g. traversal via ..) before comparing", () => {
    expect(
      isPathInsideDir(
        "/home/user/.claude/projects/foo/../../../../etc/passwd",
        "/home/user/.claude/projects",
      ),
    ).toBe(false);
  });
});

describe("buildDaemon rescanClaudeTranscript path guard", () => {
  let sojournHomeDir: string;
  let claudeConfigDir: string;
  let originalSojournHome: string | undefined;
  let originalClaudeConfigDir: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sojournHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-wire-home-"));
    claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-wire-claude-"));
    fs.mkdirSync(path.join(claudeConfigDir, "projects"), { recursive: true });

    originalSojournHome = process.env.SOJOURN_HOME;
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.SOJOURN_HOME = sojournHomeDir;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (originalSojournHome === undefined) delete process.env.SOJOURN_HOME;
    else process.env.SOJOURN_HOME = originalSojournHome;
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;

    fs.rmSync(sojournHomeDir, { recursive: true, force: true });
    fs.rmSync(claudeConfigDir, { recursive: true, force: true });
  });

  it("reads and ingests a transcript INSIDE claudeProjectsDir()", async () => {
    const daemon = buildDaemon();
    const server = http.createServer();
    const app = daemon.createExpressApp(server);

    const insidePath = path.join(claudeConfigDir, "projects", "some-project", "session.jsonl");
    fs.mkdirSync(path.dirname(insidePath), { recursive: true });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-wire-project-"));
    try {
      const line = JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "sess-1",
        cwd: projectRoot,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      });
      fs.writeFileSync(insidePath, line + "\n");

      const request = await import("supertest");
      const res = await request.default(app).post("/api/hooks/claude").send({
        session_id: "sess-1",
        transcript_path: insidePath,
        cwd: projectRoot,
        hook_event_name: "PostToolUse",
      });
      expect(res.status).toBe(200);

      // give the fire-and-forget rescan a tick to run.
      await new Promise((resolve) => setTimeout(resolve, 20));

      const projects = daemon.store.getProjects();
      expect(projects.some((p) => p.root === projectRoot)).toBe(true);
    } finally {
      daemon.store.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("does NOT read a transcript_path OUTSIDE claudeProjectsDir() (e.g. /etc/passwd)", async () => {
    const daemon = buildDaemon();
    const server = http.createServer();
    const app = daemon.createExpressApp(server);

    try {
      const request = await import("supertest");
      const res = await request.default(app).post("/api/hooks/claude").send({
        session_id: "sess-evil",
        transcript_path: "/etc/passwd",
        cwd: "/etc",
        hook_event_name: "PostToolUse",
      });
      expect(res.status).toBe(200);

      await new Promise((resolve) => setTimeout(resolve, 20));

      // Nothing should have been ingested — no project rows created.
      expect(daemon.store.getProjects()).toEqual([]);
      // A single stderr line should have been logged for the rejected path.
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      daemon.store.close();
    }
  });
});
