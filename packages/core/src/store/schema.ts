import type BetterSqlite3 from "better-sqlite3";

/**
 * Idempotent DDL for the Sojourn graph store. Safe to run on every open.
 */
export const DDL = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, cli TEXT NOT NULL CHECK (cli IN ('claude','opencode')),
  title TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS nodes(
  id TEXT PRIMARY KEY, parent_id TEXT, kind TEXT NOT NULL, cli TEXT NOT NULL,
  session_id TEXT NOT NULL, project_id TEXT NOT NULL, timestamp TEXT NOT NULL,
  snapshot_ref TEXT, label TEXT, summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT 'null', native_uuid TEXT NOT NULL, forked_from TEXT);
CREATE INDEX IF NOT EXISTS idx_nodes_project ON nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_nodes_session ON nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE TABLE IF NOT EXISTS flags(
  id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, kind TEXT NOT NULL,
  tier TEXT NOT NULL, confidence TEXT NOT NULL, evidence TEXT NOT NULL, source TEXT NOT NULL,
  auto_resolved INTEGER NOT NULL DEFAULT 0, dismissed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(node_id, kind, evidence));
CREATE TABLE IF NOT EXISTS annotations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
`;

export function applySchema(db: BetterSqlite3.Database): void {
  db.pragma("journal_mode = WAL");
  db.exec(DDL);
}
