import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { runMigrations } from "./migrations.js";
import { projectIdFor } from "../paths.js";
import type {
  Annotation,
  ChronoNode,
  Cli,
  FileChange,
  Flag,
  NodeKind,
  Project,
  SearchHit,
  SessionRow,
  StoredFlag,
} from "../types.js";

interface NodeRow {
  id: string;
  parent_id: string | null;
  kind: string;
  cli: string;
  session_id: string;
  project_id: string;
  timestamp: string;
  snapshot_ref: string | null;
  label: string | null;
  summary: string;
  content: string;
  native_uuid: string;
  forked_from: string | null;
  rowid: number;
}

interface FlagRow {
  id: number;
  node_id: string;
  kind: string;
  tier: string;
  confidence: string;
  evidence: string;
  source: string;
  auto_resolved: number;
  dismissed: number;
  created_at: string;
  suppressed_count: number;
}

interface AnnotationRow {
  id: number;
  node_id: string;
  text: string;
  created_at: string;
}

interface ProjectRow {
  id: string;
  root: string;
  name: string;
  created_at: string;
}

interface SessionDbRow {
  id: string;
  project_id: string;
  cli: string;
  title: string | null;
  created_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return { id: row.id, root: row.root, name: row.name, createdAt: row.created_at };
}

function rowToSession(row: SessionDbRow): SessionRow {
  return {
    id: row.id,
    projectId: row.project_id,
    cli: row.cli as Cli,
    title: row.title,
    createdAt: row.created_at,
  };
}

function rowToFlag(row: FlagRow): StoredFlag {
  return {
    id: row.id,
    nodeId: row.node_id,
    kind: row.kind as StoredFlag["kind"],
    tier: row.tier as StoredFlag["tier"],
    confidence: row.confidence as StoredFlag["confidence"],
    evidence: row.evidence,
    source: row.source as StoredFlag["source"],
    autoResolved: row.auto_resolved === 1,
    dismissed: row.dismissed === 1,
    createdAt: row.created_at,
    ...(row.suppressed_count > 0 ? { suppressedCount: row.suppressed_count } : {}),
  };
}

function rowToAnnotation(row: AnnotationRow): Annotation {
  return { id: row.id, nodeId: row.node_id, text: row.text, createdAt: row.created_at };
}

function rowToNode(row: NodeRow): ChronoNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind as ChronoNode["kind"],
    cli: row.cli as Cli,
    sessionId: row.session_id,
    projectId: row.project_id,
    timestamp: row.timestamp,
    snapshotRef: row.snapshot_ref,
    label: row.label,
    summary: row.summary,
    content: JSON.parse(row.content),
    meta: {
      nativeUuid: row.native_uuid,
      ...(row.forked_from !== null ? { forkedFrom: row.forked_from } : {}),
    },
  };
}

export class GraphStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    applySchema(this.db);
    runMigrations(this.db);
  }

  upsertProject(root: string, name?: string): Project {
    const id = projectIdFor(root);
    const existing = this.db
      .prepare<[string], ProjectRow>("SELECT * FROM projects WHERE id = ?")
      .get(id);
    if (existing) {
      if (name !== undefined && name !== existing.name) {
        this.db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
      }
    } else {
      this.db
        .prepare("INSERT INTO projects (id, root, name) VALUES (?, ?, ?)")
        .run(id, root, name ?? root);
    }
    return this.getProject(id)!;
  }

  getProjects(): Project[] {
    const rows = this.db
      .prepare<[], ProjectRow>("SELECT * FROM projects ORDER BY created_at ASC, rowid ASC")
      .all();
    return rows.map(rowToProject);
  }

  getProject(id: string): Project | null {
    const row = this.db
      .prepare<[string], ProjectRow>("SELECT * FROM projects WHERE id = ?")
      .get(id);
    return row ? rowToProject(row) : null;
  }

  upsertSession(s: { id: string; projectId: string; cli: Cli; title?: string }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, project_id, cli, title) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id,
           cli = excluded.cli, title = excluded.title`,
      )
      .run(s.id, s.projectId, s.cli, s.title ?? null);
  }

  getSessions(projectId: string): SessionRow[] {
    const rows = this.db
      .prepare<[string], SessionDbRow>(
        "SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(projectId);
    return rows.map(rowToSession);
  }

  upsertNode(node: ChronoNode): void {
    const existing = this.db
      .prepare<[string], { snapshot_ref: string | null }>(
        "SELECT snapshot_ref FROM nodes WHERE id = ?",
      )
      .get(node.id);

    const snapshotRef =
      node.snapshotRef !== null ? node.snapshotRef : (existing?.snapshot_ref ?? null);

    this.db
      .prepare(
        `INSERT INTO nodes
           (id, parent_id, kind, cli, session_id, project_id, timestamp,
            snapshot_ref, label, summary, content, native_uuid, forked_from)
         VALUES (@id, @parent_id, @kind, @cli, @session_id, @project_id, @timestamp,
            @snapshot_ref, @label, @summary, @content, @native_uuid, @forked_from)
         ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id,
           kind = excluded.kind,
           cli = excluded.cli,
           session_id = excluded.session_id,
           project_id = excluded.project_id,
           timestamp = excluded.timestamp,
           snapshot_ref = excluded.snapshot_ref,
           label = excluded.label,
           summary = excluded.summary,
           content = excluded.content,
           native_uuid = excluded.native_uuid,
           forked_from = excluded.forked_from`,
      )
      .run({
        id: node.id,
        parent_id: node.parentId,
        kind: node.kind,
        cli: node.cli,
        session_id: node.sessionId,
        project_id: node.projectId,
        timestamp: node.timestamp,
        snapshot_ref: snapshotRef,
        label: node.label,
        summary: node.summary,
        content: JSON.stringify(node.content ?? null),
        native_uuid: node.meta.nativeUuid,
        forked_from: node.meta.forkedFrom ?? null,
      });

    this.reindexNodeFts(node.id);
  }

  getNode(id: string): ChronoNode | null {
    const row = this.db
      .prepare<[string], NodeRow>("SELECT rowid, * FROM nodes WHERE id = ?")
      .get(id);
    if (!row) return null;
    const node = rowToNode(row);
    node.flags = this.getFlags(id);
    node.annotations = this.getAnnotations(id);
    return node;
  }

  getChildren(id: string): ChronoNode[] {
    const rows = this.db
      .prepare<[string], NodeRow>(
        "SELECT rowid, * FROM nodes WHERE parent_id = ? ORDER BY timestamp ASC, rowid ASC",
      )
      .all(id);
    return rows.map((r) => {
      const node = rowToNode(r);
      node.flags = this.getFlags(node.id);
      node.annotations = this.getAnnotations(node.id);
      return node;
    });
  }

  getGraph(projectId: string): ChronoNode[] {
    const rows = this.db
      .prepare<[string], NodeRow>(
        "SELECT rowid, * FROM nodes WHERE project_id = ? ORDER BY timestamp ASC, rowid ASC",
      )
      .all(projectId);
    return rows.map((r) => {
      const node = rowToNode(r);
      node.flags = this.getFlags(node.id);
      node.annotations = this.getAnnotations(node.id);
      return node;
    });
  }

  getSessionNodes(sessionId: string): ChronoNode[] {
    const rows = this.db
      .prepare<[string], NodeRow>(
        "SELECT rowid, * FROM nodes WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC",
      )
      .all(sessionId);
    return rows.map((r) => {
      const node = rowToNode(r);
      node.flags = this.getFlags(node.id);
      node.annotations = this.getAnnotations(node.id);
      return node;
    });
  }

  latestNode(sessionId: string): ChronoNode | null {
    const row = this.db
      .prepare<[string], NodeRow>(
        "SELECT rowid, * FROM nodes WHERE session_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId);
    if (!row) return null;
    const node = rowToNode(row);
    node.flags = this.getFlags(node.id);
    node.annotations = this.getAnnotations(node.id);
    return node;
  }

  setSnapshotRef(nodeId: string, tree: string): void {
    this.db.prepare("UPDATE nodes SET snapshot_ref = ? WHERE id = ?").run(tree, nodeId);
  }

  /**
   * `flag` accepts an optional `suppressedCount` (present on budget-digest
   * flags — see `packages/core/src/flags/budget.ts`'s `DigestFlag`, which
   * is a `Flag` plus that one field) so digest rows persist their rollup
   * count; ordinary flags simply omit it and store 0.
   *
   * (node_id, kind, evidence) stays the uniqueness key for both, but
   * conflict behavior differs by flag type:
   *  - ordinary flag (no suppressedCount): DO NOTHING — re-inserting a
   *    duplicate is a pure no-op against the existing row.
   *  - digest flag (suppressedCount > 0): DO UPDATE — digest evidence is
   *    deliberately count-free ("<sample> …and similar claims suppressed"),
   *    so a re-run that suppresses a DIFFERENT number of claims produces
   *    the SAME evidence string and lands here as a conflict; the existing
   *    row's suppressed_count is updated in place (and its confidence
   *    raised if the incoming digest's is higher — never lowered) instead
   *    of inserting a near-duplicate row per distinct count.
   *    dismissed/auto_resolved are left untouched: a user's dismissal of a
   *    digest survives re-runs.
   */
  addFlag(nodeId: string, flag: Flag & { suppressedCount?: number }): StoredFlag {
    const params = {
      node_id: nodeId,
      kind: flag.kind,
      tier: flag.tier,
      confidence: flag.confidence,
      evidence: flag.evidence,
      source: flag.source,
      auto_resolved: flag.autoResolved ? 1 : 0,
      suppressed_count: flag.suppressedCount ?? 0,
    };
    const insertColumns = `INSERT INTO flags (node_id, kind, tier, confidence, evidence, source, auto_resolved, suppressed_count)
         VALUES (@node_id, @kind, @tier, @confidence, @evidence, @source, @auto_resolved, @suppressed_count)`;
    if ((flag.suppressedCount ?? 0) > 0) {
      this.db
        .prepare(
          `${insertColumns}
         ON CONFLICT(node_id, kind, evidence) DO UPDATE SET
           suppressed_count = excluded.suppressed_count,
           confidence = CASE
             WHEN (CASE excluded.confidence WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END)
                > (CASE flags.confidence WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END)
             THEN excluded.confidence
             ELSE flags.confidence
           END`,
        )
        .run(params);
    } else {
      this.db
        .prepare(
          `${insertColumns}
         ON CONFLICT(node_id, kind, evidence) DO NOTHING`,
        )
        .run(params);
    }
    const row = this.db
      .prepare<[string, string, string], FlagRow>(
        "SELECT * FROM flags WHERE node_id = ? AND kind = ? AND evidence = ?",
      )
      .get(nodeId, flag.kind, flag.evidence)!;
    return rowToFlag(row);
  }

  getFlags(nodeId: string): StoredFlag[] {
    const rows = this.db
      .prepare<[string], FlagRow>(
        "SELECT * FROM flags WHERE node_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(nodeId);
    return rows.map(rowToFlag);
  }

  resolveFlag(flagId: number): void {
    this.db.prepare("UPDATE flags SET auto_resolved = 1 WHERE id = ?").run(flagId);
  }

  dismissFlag(flagId: number): void {
    this.db.prepare("UPDATE flags SET dismissed = 1 WHERE id = ?").run(flagId);
  }

  addAnnotation(nodeId: string, text: string): Annotation {
    const info = this.db
      .prepare("INSERT INTO annotations (node_id, text) VALUES (?, ?)")
      .run(nodeId, text);
    const row = this.db
      .prepare<[number], AnnotationRow>("SELECT * FROM annotations WHERE id = ?")
      .get(Number(info.lastInsertRowid))!;
    this.reindexNodeFts(nodeId);
    return rowToAnnotation(row);
  }

  private getAnnotations(nodeId: string): Annotation[] {
    const rows = this.db
      .prepare<[string], AnnotationRow>(
        "SELECT * FROM annotations WHERE node_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(nodeId);
    return rows.map(rowToAnnotation);
  }

  /**
   * Rebuilds the `node_fts` row for one node from current DB state:
   * summary + label + every annotation's text. `node_fts` has no unique
   * constraint of its own (FTS5 virtual tables don't support one), so this
   * is always delete-then-insert rather than an upsert. Reading current
   * state back off the row (rather than trusting only the field the
   * caller just touched) means BOTH callers stay correct without knowing
   * about each other: upsertNode re-touching a node with existing
   * annotations doesn't blank them out of the index, and addAnnotation
   * doesn't need its own copy of summary/label composition logic.
   */
  private reindexNodeFts(nodeId: string): void {
    const node = this.db
      .prepare<[string], { label: string | null; summary: string }>(
        "SELECT label, summary FROM nodes WHERE id = ?",
      )
      .get(nodeId);
    if (!node) return;
    const annotationTexts = this.db
      .prepare<[string], { text: string }>(
        "SELECT text FROM annotations WHERE node_id = ? ORDER BY id ASC",
      )
      .all(nodeId)
      .map((r) => r.text);
    const content = [node.summary, node.label ?? "", ...annotationTexts]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join("\n");

    this.db.prepare("DELETE FROM node_fts WHERE node_id = ?").run(nodeId);
    this.db
      .prepare("INSERT INTO node_fts (node_id, content) VALUES (?, ?)")
      .run(nodeId, content);
  }

  /**
   * Replaces the `node_files` rows for one node with `files`. Callers
   * (daemon ingest, Wave C) pass the TURN's file diffs indexed onto the
   * turn's prompt node id and/or the batch-tail node id.
   */
  indexNodeFiles(nodeId: string, files: FileChange[]): void {
    const del = this.db.prepare("DELETE FROM node_files WHERE node_id = ?");
    const insert = this.db.prepare(
      "INSERT INTO node_files (node_id, path, status) VALUES (?, ?, ?)",
    );
    const run = this.db.transaction((rows: FileChange[]) => {
      del.run(nodeId);
      for (const f of rows) insert.run(nodeId, f.path, f.status);
    });
    run(files);
  }

  /**
   * Full-text + file-path + kind search, always scoped to one project.
   *
   * - `q` runs against `node_fts` (summary + label + annotations, kept
   *   current by upsertNode/addAnnotation). Each whitespace token is
   *   individually quoted (embedded `"` doubled) before being handed to
   *   FTS5's MATCH — this turns every token into a literal phrase, so
   *   FTS5 query-syntax characters an end user might type (`OR`, `NOT`,
   *   `NEAR`, `^`, `:`, unbalanced `"`) are searched for as literal text
   *   instead of being parsed as operators. MATCH never throws on
   *   arbitrary input as a result, and results can only ever be a subset
   *   of "rows containing these literal tokens" — no over-matching.
   * - `file` matches node_files by exact path or `.../basename` suffix.
   * - `kinds` filters nodes.kind.
   * - Results are always scoped to `projectId` (cross-project isolation).
   *
   * Ranking: FTS hits are ordered by bm25 (best match first); SQLite's
   * bm25() returns more-negative-is-better, so `score = -bm25` makes
   * higher-is-better the SearchHit convention. Non-FTS (file/kind-only)
   * results have no relevance signal to rank by, so they fall back to
   * recency (newest first) with a flat score.
   */
  search(
    projectId: string,
    opts: { q?: string; file?: string; kinds?: NodeKind[]; limit?: number } = {},
  ): SearchHit[] {
    const limit = opts.limit ?? 50;
    const ftsQuery = opts.q ? sanitizeFtsQuery(opts.q) : "";
    const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : null;

    const whereParts: string[] = ["n.project_id = @projectId"];
    const params: Record<string, unknown> = { projectId, limit };

    if (kinds) {
      whereParts.push(`n.kind IN (${kinds.map((_, i) => `@kind${i}`).join(", ")})`);
      kinds.forEach((k, i) => {
        params[`kind${i}`] = k;
      });
    }

    if (opts.file) {
      whereParts.push(
        "n.id IN (SELECT node_id FROM node_files WHERE path = @filePath OR path LIKE @fileSuffix ESCAPE '\\')",
      );
      params.filePath = opts.file;
      params.fileSuffix = `%/${escapeLike(opts.file)}`;
    }

    const where = whereParts.join(" AND ");

    if (ftsQuery) {
      params.ftsQuery = ftsQuery;
      const rows = this.db
        .prepare<Record<string, unknown>, NodeRow & { bm25score: number; snip: string }>(
          `SELECT n.rowid as rowid, n.*, bm25(node_fts) as bm25score,
                  snippet(node_fts, 1, '', '', '…', 12) as snip
           FROM node_fts
           JOIN nodes n ON n.id = node_fts.node_id
           WHERE node_fts MATCH @ftsQuery AND ${where}
           ORDER BY bm25score ASC
           LIMIT @limit`,
        )
        .all(params);
      return rows.map((r) => ({
        node: this.hydrate(rowToNode(r)),
        score: -r.bm25score,
        snippet: r.snip,
      }));
    }

    const rows = this.db
      .prepare<Record<string, unknown>, NodeRow>(
        `SELECT n.rowid as rowid, n.*
         FROM nodes n
         WHERE ${where}
         ORDER BY n.timestamp DESC, n.rowid DESC
         LIMIT @limit`,
      )
      .all(params);
    return rows.map((r) => ({
      node: this.hydrate(rowToNode(r)),
      score: 0,
      snippet: excerpt(r.summary || r.label || ""),
    }));
  }

  private hydrate(node: ChronoNode): ChronoNode {
    node.flags = this.getFlags(node.id);
    node.annotations = this.getAnnotations(node.id);
    return node;
  }

  close(): void {
    this.db.close();
  }
}

/** Doubles embedded `"` and wraps each whitespace-separated token in its
 * own `"..."` phrase so FTS5 treats user input as literal text, never
 * query syntax. Returns "" for empty/whitespace-only input (caller skips
 * the FTS branch entirely in that case). */
function sanitizeFtsQuery(q: string): string {
  const tokens = q.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/** Escapes SQL LIKE wildcards (`%`, `_`) so a literal file path never
 * accidentally behaves like a pattern. Pair with `ESCAPE '\'`. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Manual excerpt fallback for hits with no FTS match to snippet() around
 * (file/kind-only search). */
function excerpt(text: string, max = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}
