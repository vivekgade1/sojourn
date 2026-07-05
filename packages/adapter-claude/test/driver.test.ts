import { describe, it, expect } from "vitest";
import { buildResumeCommand } from "../src/driver.js";

describe("buildResumeCommand", () => {
  it("builds a plain resume command with --fork-session", () => {
    expect(buildResumeCommand("session-abc")).toBe(
      "claude --resume session-abc --fork-session",
    );
  });

  it("prefixes with a cd into the worktree when opts.worktree is given", () => {
    expect(buildResumeCommand("session-abc", { worktree: "/repo/wt-1" })).toBe(
      "cd /repo/wt-1 && claude --resume session-abc --fork-session",
    );
  });

  it("does not add a cd prefix when opts is given but worktree is undefined", () => {
    expect(buildResumeCommand("session-abc", {})).toBe(
      "claude --resume session-abc --fork-session",
    );
  });

  it("works with a session id containing typical uuid characters", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(buildResumeCommand(id)).toBe(`claude --resume ${id} --fork-session`);
  });
});
