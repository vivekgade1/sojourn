import Database from "better-sqlite3";
import { applySchema } from "./schema.js";
import { runMigrations } from "./migrations.js";
import { projectIdFor } from "../paths.js";
import type {
  Annotation,
  ChronoNode,
  Cli,
  Flag,
  Project,
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

  addFlag(nodeId: string, flag: Flag): StoredFlag {
    this.db
      .prepare(
        `INSERT INTO flags (node_id, kind, tier, confidence, evidence, source, auto_resolved)
         VALUES (@node_id, @kind, @tier, @confidence, @evidence, @source, @auto_resolved)
         ON CONFLICT(node_id, kind, evidence) DO NOTHING`,
      )
      .run({
        node_id: nodeId,
        kind: flag.kind,
        tier: flag.tier,
        confidence: flag.confidence,
        evidence: flag.evidence,
        source: flag.source,
        auto_resolved: flag.autoResolved ? 1 : 0,
      });
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

  close(): void {
    this.db.close();
  }
}
