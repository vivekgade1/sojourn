/**
 * Options for {@link buildResumeCommand}.
 */
export interface BuildResumeCommandOptions {
  /**
   * Absolute path to a git worktree the resumed session should run in. When
   * given, the returned command is prefixed with `cd <worktree> && ` so the
   * shell lands in the right directory before invoking `claude`.
   */
  worktree?: string;
}

/**
 * Builds the shell command that resumes a Claude Code session and forks it
 * into a new session (so the original transcript is left untouched).
 *
 * Given only a session id, returns:
 *   `claude --resume <sessionId> --fork-session`
 *
 * Given `opts.worktree`, prefixes with a `cd` into that directory:
 *   `cd <worktree> && claude --resume <sessionId> --fork-session`
 */
export function buildResumeCommand(
  sessionId: string,
  opts?: BuildResumeCommandOptions,
): string {
  const base = `claude --resume ${sessionId} --fork-session`;
  if (opts?.worktree) {
    return `cd ${opts.worktree} && ${base}`;
  }
  return base;
}
