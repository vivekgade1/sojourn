/**
 * Session -> transcript-location mapping for Claude sessions.
 *
 * The rewind routes (POST /api/nodes/:id/rewind-plan and /rewind) need the
 * ORIGINAL transcript's raw lines, and the flag routes need the ACTUAL disk
 * root a session ran in (a restored worktree for aliased sessions — V2
 * Task 7). Both facts are only known at parse time, by the two callers that
 * read transcript files off disk: the chokidar watcher's scan and the
 * hook-triggered rescan in wire.ts. They record here; routes read here.
 *
 * In-memory by design: the watcher starts with `ignoreInitial: false`, so
 * every existing transcript is re-scanned (and re-recorded) on daemon
 * startup — the index self-heals across restarts. Until a session's file
 * has been seen at least once, rewind routes answer 404 ("transcript not
 * known") rather than guessing at paths.
 */

export interface TranscriptRecord {
  /** Absolute path of the session's transcript `.jsonl` file. */
  transcriptPath: string;
  /**
   * The transcript's recorded cwd (the parsed batch's `project.root`) —
   * the directory the session ACTUALLY ran in, which for worktree-aliased
   * sessions differs from the origin project's root the session is stored
   * under.
   */
  diskRoot: string;
}

/** Read-only view routes depend on (tests inject simple stubs). */
export interface TranscriptIndexLike {
  get(sessionId: string): TranscriptRecord | null;
}

export class TranscriptIndex implements TranscriptIndexLike {
  private readonly bySession = new Map<string, TranscriptRecord>();

  record(sessionId: string, rec: TranscriptRecord): void {
    if (!sessionId || !rec.transcriptPath) return;
    this.bySession.set(sessionId, rec);
  }

  get(sessionId: string): TranscriptRecord | null {
    return this.bySession.get(sessionId) ?? null;
  }
}
