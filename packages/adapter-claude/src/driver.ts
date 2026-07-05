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
 * Wraps a value in single quotes for safe interpolation into a POSIX shell
 * command, escaping any embedded single quotes.
 *
 * Uses the standard `'\''` trick: close the quote, emit an escaped literal
 * single quote, then reopen the quote. This guarantees the resulting token
 * is treated as one literal argument regardless of spaces, `&&`, `$`, or
 * other shell metacharacters it may contain.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Builds the shell command that resumes a Claude Code session and forks it
 * into a new session (so the original transcript is left untouched).
 *
 * Given only a session id, returns:
 *   `claude --resume '<sessionId>' --fork-session`
 *
 * Given `opts.worktree`, prefixes with a `cd` into that directory:
 *   `cd '<worktree>' && claude --resume '<sessionId>' --fork-session`
 *
 * Both the worktree path and the session id are single-quoted (with
 * embedded single quotes escaped) so that spaces or shell metacharacters in
 * either value cannot break the command or be interpreted by the shell.
 */
export function buildResumeCommand(
  sessionId: string,
  opts?: BuildResumeCommandOptions,
): string {
  const base = `claude --resume ${shellQuote(sessionId)} --fork-session`;
  if (opts?.worktree) {
    return `cd ${shellQuote(opts.worktree)} && ${base}`;
  }
  return base;
}
