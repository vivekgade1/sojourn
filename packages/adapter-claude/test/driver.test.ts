import { describe, it, expect } from "vitest";
import { buildResumeCommand } from "../src/driver.js";

describe("buildResumeCommand", () => {
  it("builds a plain resume command with --fork-session, single-quoting the session id", () => {
    expect(buildResumeCommand("session-abc")).toBe(
      "claude --resume 'session-abc' --fork-session",
    );
  });

  it("prefixes with a cd into the worktree when opts.worktree is given, single-quoting both", () => {
    expect(buildResumeCommand("session-abc", { worktree: "/repo/wt-1" })).toBe(
      "cd '/repo/wt-1' && claude --resume 'session-abc' --fork-session",
    );
  });

  it("does not add a cd prefix when opts is given but worktree is undefined", () => {
    expect(buildResumeCommand("session-abc", {})).toBe(
      "claude --resume 'session-abc' --fork-session",
    );
  });

  it("works with a session id containing typical uuid characters (plain UUID still works)", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(buildResumeCommand(id)).toBe(`claude --resume '${id}' --fork-session`);
  });

  it("single-quotes a worktree path containing a space", () => {
    expect(
      buildResumeCommand("11111111-1111-1111-1111-111111111111", {
        worktree: "/repo/my project",
      }),
    ).toBe(
      "cd '/repo/my project' && claude --resume '11111111-1111-1111-1111-111111111111' --fork-session",
    );
  });

  it("escapes an embedded single quote in the worktree path", () => {
    expect(buildResumeCommand("session-abc", { worktree: "/repo/it's-mine" })).toBe(
      "cd '/repo/it'\\''s-mine' && claude --resume 'session-abc' --fork-session",
    );
  });

  it("escapes an embedded single quote in the session id", () => {
    expect(buildResumeCommand("session-'abc")).toBe(
      "claude --resume 'session-'\\''abc' --fork-session",
    );
  });
});
