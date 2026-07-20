import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { GraphStore } from "../src/store/graphStore.js";
import {
  runMigrations,
  MIGRATIONS,
  SojournMigrationError,
  type Migration,
} from "../src/store/migrations.js";

/**
 * frozen copy of V1 DDL — do NOT sync with schema.ts; drift here is the
 * point. These tests assert how runMigrations behaves against the exact
 * V1 base schema every real ~/.sojourn/graph.db shipped with; importing
 * schema.ts's live `DDL` export would silently follow any future edit to
 * that file and defeat the purpose of a stable migrate-from-V1 fixture.
 */
const V1_DDL = `
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

/** GraphStore keeps its better-sqlite3 handle private; migrations tests need
 * to introspect raw schema/pragma state that has no public GraphStore
 * accessor, so we reach past the TS-only privacy boundary here. This is
 * test-only reflection — production code never does this. */
function rawDb(store: GraphStore): BetterSqlite3.Database {
  return (store as unknown as { db: BetterSqlite3.Database }).db;
}

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sojourn-migrations-"));
  return path.join(dir, "graph.db");
}

function userVersion(db: BetterSqlite3.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

describe("runMigrations via GraphStore", () => {
  describe("fresh database", () => {
    it("lands at user_version 4", () => {
      const store = new GraphStore(":memory:");
      try {
        expect(userVersion(rawDb(store))).toBe(4);
      } finally {
        store.close();
      }
    });

    it("adds flags.suppressed_count as NOT NULL DEFAULT 0", () => {
      const store = new GraphStore(":memory:");
      try {
        const cols = rawDb(store).prepare("PRAGMA table_info(flags)").all() as Array<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>;
        const col = cols.find((c) => c.name === "suppressed_count");
        expect(col).toBeDefined();
        expect(col?.notnull).toBe(1);
        expect(col?.dflt_value).toBe("0");
      } finally {
        store.close();
      }
    });

    it("v3: adds nodes.rewind_of, and meta.rewindOf round-trips through upsertNode/getNode", () => {
      const store = new GraphStore(":memory:");
      try {
        const cols = (rawDb(store).prepare("PRAGMA table_info(nodes)").all() as Array<{
          name: string;
        }>).map((c) => c.name);
        expect(cols).toContain("rewind_of");

        store.upsertProject("/repo/rw", "RW");
        const projectId = store.getProjects()[0].id;
        store.upsertNode({
          id: "claude:origin",
          parentId: null,
          kind: "assistant",
          cli: "claude",
          sessionId: "s-a",
          projectId,
          timestamp: "2026-01-01T00:00:00.000Z",
          snapshotRef: null,
          label: null,
          summary: "",
          content: {},
          meta: { nativeUuid: "origin" },
        });
        store.upsertNode({
          id: "claude:rewound-root",
          parentId: "claude:origin",
          kind: "prompt",
          cli: "claude",
          sessionId: "s-b",
          projectId,
          timestamp: "2026-01-02T00:00:00.000Z",
          snapshotRef: null,
          label: null,
          summary: "",
          content: {},
          meta: { nativeUuid: "rewound-root", rewindOf: "claude:origin" },
        });

        const stored = store.getNode("claude:rewound-root")!;
        expect(stored.meta.rewindOf).toBe("claude:origin");
        // absent stays absent — no null leaking into meta
        expect(store.getNode("claude:origin")!.meta.rewindOf).toBeUndefined();
      } finally {
        store.close();
      }
    });

    it("v4: adds nodes.merged_from, and meta.mergedFrom round-trips through upsertNode/getNode", () => {
      const store = new GraphStore(":memory:");
      try {
        const cols = (rawDb(store).prepare("PRAGMA table_info(nodes)").all() as Array<{
          name: string;
        }>).map((c) => c.name);
        expect(cols).toContain("merged_from");

        store.upsertProject("/repo/mg", "MG");
        const projectId = store.getProjects()[0].id;
        const base = {
          kind: "assistant" as const,
          cli: "claude" as const,
          projectId,
          snapshotRef: null,
          label: null,
          summary: "",
          content: {},
        };
        store.upsertNode({
          ...base,
          id: "claude:side-a",
          parentId: null,
          sessionId: "s-a",
          timestamp: "2026-01-01T00:00:00.000Z",
          meta: { nativeUuid: "side-a" },
        });
        store.upsertNode({
          ...base,
          id: "claude:side-b",
          parentId: null,
          sessionId: "s-b",
          timestamp: "2026-01-01T00:00:00.000Z",
          meta: { nativeUuid: "side-b" },
        });
        store.upsertNode({
          ...base,
          id: "claude:combined",
          kind: "checkpoint",
          parentId: "claude:side-a",
          sessionId: "s-a",
          timestamp: "2026-01-02T00:00:00.000Z",
          meta: { nativeUuid: "combined", mergedFrom: "claude:side-b" },
        });

        const stored = store.getNode("claude:combined")!;
        expect(stored.meta.mergedFrom).toBe("claude:side-b");
        // the graph stays a TREE: parentId remains the single structural edge
        expect(stored.parentId).toBe("claude:side-a");
        // absent stays absent — no null leaking into meta
        expect(store.getNode("claude:side-a")!.meta.mergedFrom).toBeUndefined();
        expect("mergedFrom" in store.getNode("claude:side-a")!.meta).toBe(false);
      } finally {
        store.close();
      }
    });

    it("creates node_files(node_id, path, status) with indexes on path and node_id", () => {
      const store = new GraphStore(":memory:");
      try {
        const db = rawDb(store);
        const cols = (db.prepare("PRAGMA table_info(node_files)").all() as Array<{
          name: string;
        }>).map((c) => c.name);
        expect(cols).toEqual(["node_id", "path", "status"]);

        const indexes = db.prepare("PRAGMA index_list(node_files)").all() as Array<{
          name: string;
        }>;
        const indexedColumns = indexes.map(
          (idx) =>
            (db.prepare(`PRAGMA index_info(${idx.name})`).all() as Array<{ name: string }>)[0]
              ?.name,
        );
        expect(indexedColumns.sort()).toEqual(["node_id", "path"]);

        // usable
        db.prepare("INSERT INTO node_files (node_id, path, status) VALUES (?, ?, ?)").run(
          "n1",
          "src/index.ts",
          "M",
        );
        expect(
          (db.prepare("SELECT COUNT(*) c FROM node_files").get() as { c: number }).c,
        ).toBe(1);
      } finally {
        store.close();
      }
    });

    it("creates a queryable contentless-ok node_fts FTS5 table", () => {
      const store = new GraphStore(":memory:");
      try {
        const db = rawDb(store);
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'node_fts'")
          .get() as { sql: string } | undefined;
        expect(row?.sql.toLowerCase()).toContain("fts5");

        // empty by default (population is Task 8's job)
        expect(
          (db.prepare("SELECT COUNT(*) c FROM node_fts").get() as { c: number }).c,
        ).toBe(0);

        // but fully usable
        db.prepare("INSERT INTO node_fts (node_id, content) VALUES (?, ?)").run(
          "n1",
          "hello world",
        );
        const hit = db
          .prepare("SELECT node_id FROM node_fts WHERE node_fts MATCH ?")
          .get("hello");
        expect(hit).toEqual({ node_id: "n1" });
      } finally {
        store.close();
      }
    });
  });

  describe("upgrading a real V1 fixture database", () => {
    it("upgrades losslessly: row counts preserved, new column readable with default 0", () => {
      const dbPath = tmpDbPath();

      // Build a genuine V1-shape database using the exact V1 DDL — this is
      // schema.ts unmodified by the v2 migration, i.e. what every real V1
      // ~/.sojourn/graph.db looks like today (user_version never stamped).
      const seed = new Database(dbPath);
      seed.pragma("journal_mode = WAL");
      seed.exec(V1_DDL);
      seed.exec(`
        INSERT INTO projects (id, root, name) VALUES
          ('proj-a', '/repo/a', 'Repo A'),
          ('proj-b', '/repo/b', 'Repo B');
        INSERT INTO sessions (id, project_id, cli) VALUES
          ('sess-1', 'proj-a', 'claude');
        INSERT INTO nodes
          (id, parent_id, kind, cli, session_id, project_id, timestamp, native_uuid)
        VALUES
          ('claude:n1', NULL, 'prompt', 'claude', 'sess-1', 'proj-a', '2026-01-01T00:00:00.000Z', 'n1'),
          ('claude:n2', 'claude:n1', 'assistant', 'claude', 'sess-1', 'proj-a', '2026-01-01T00:00:01.000Z', 'n2'),
          ('claude:n3', 'claude:n2', 'tool_use', 'claude', 'sess-1', 'proj-a', '2026-01-01T00:00:02.000Z', 'n3');
        INSERT INTO flags (node_id, kind, tier, confidence, evidence, source) VALUES
          ('claude:n2', 'edit_claim_mismatch', 'verified', 'high', 'evidence-1', 'deterministic'),
          ('claude:n3', 'possible_hallucination', 'advisory', 'low', 'evidence-2', 'llm_critic');
      `);
      expect(userVersion(seed)).toBe(0);
      seed.close();

      // Reopen through GraphStore: applySchema is a no-op (tables already
      // exist), runMigrations does the real work.
      const store = new GraphStore(dbPath);
      try {
        const db = rawDb(store);

        expect(userVersion(db)).toBe(4);
        expect((db.prepare("SELECT COUNT(*) c FROM projects").get() as { c: number }).c).toBe(2);
        expect((db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c).toBe(1);
        expect((db.prepare("SELECT COUNT(*) c FROM nodes").get() as { c: number }).c).toBe(3);
        expect((db.prepare("SELECT COUNT(*) c FROM flags").get() as { c: number }).c).toBe(2);

        // GraphStore-level round-trip still works post-upgrade.
        expect(store.getProjects().map((p) => p.id).sort()).toEqual(["proj-a", "proj-b"]);
        expect(store.getGraph("proj-a")).toHaveLength(3);

        // new column present, readable, default 0 for pre-existing rows
        const flagCounts = db
          .prepare("SELECT suppressed_count FROM flags ORDER BY id")
          .all() as Array<{ suppressed_count: number }>;
        expect(flagCounts).toEqual([{ suppressed_count: 0 }, { suppressed_count: 0 }]);

        // new structures exist, ship empty
        expect(
          (db.prepare("SELECT COUNT(*) c FROM node_files").get() as { c: number }).c,
        ).toBe(0);
        expect(
          (db.prepare("SELECT COUNT(*) c FROM node_fts").get() as { c: number }).c,
        ).toBe(0);
      } finally {
        store.close();
      }
    });
  });

  describe("upgrading a v3 database to v4", () => {
    it("adds merged_from as NULL on existing rows, leaving every other column intact", () => {
      const dbPath = tmpDbPath();

      // Build a genuine v3 database: V1 base schema + only the migrations
      // that existed before v4, then populate it.
      const seed = new Database(dbPath);
      seed.exec(V1_DDL);
      runMigrations(seed, MIGRATIONS.filter((m) => m.version <= 3));
      expect(userVersion(seed)).toBe(3);
      seed.exec(`
        INSERT INTO projects (id, root, name) VALUES ('proj-v3', '/repo/v3', 'V3');
        INSERT INTO sessions (id, project_id, cli, title) VALUES ('s-v3', 'proj-v3', 'claude', 'T');
        INSERT INTO nodes (id, parent_id, kind, cli, session_id, project_id, timestamp,
                           snapshot_ref, label, summary, content, native_uuid, forked_from, rewind_of)
        VALUES ('claude:v3a', NULL, 'prompt', 'claude', 's-v3', 'proj-v3',
                '2026-01-01T00:00:00.000Z', 'tree-aaa', 'kept label', 'kept summary',
                '{"k":1}', 'v3a', 'claude:forked', 'claude:rewound');
      `);
      seed.close();

      const store = new GraphStore(dbPath);
      try {
        const db = rawDb(store);
        expect(userVersion(db)).toBe(4);

        const cols = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{
          name: string;
        }>).map((c) => c.name);
        expect(cols).toContain("merged_from");

        // pre-existing row survives untouched, new column reads NULL
        const row = db.prepare("SELECT * FROM nodes WHERE id = 'claude:v3a'").get() as Record<
          string,
          unknown
        >;
        expect(row.merged_from).toBeNull();
        expect(row.label).toBe("kept label");
        expect(row.summary).toBe("kept summary");
        expect(row.snapshot_ref).toBe("tree-aaa");
        expect(row.forked_from).toBe("claude:forked");
        expect(row.rewind_of).toBe("claude:rewound");

        // and it hydrates through GraphStore with mergedFrom simply absent
        const node = store.getNode("claude:v3a")!;
        expect(node.meta.forkedFrom).toBe("claude:forked");
        expect(node.meta.rewindOf).toBe("claude:rewound");
        expect("mergedFrom" in node.meta).toBe(false);
      } finally {
        store.close();
      }
    });

    it("is idempotent across a re-open of the upgraded database", () => {
      const dbPath = tmpDbPath();
      const seed = new Database(dbPath);
      seed.exec(V1_DDL);
      runMigrations(seed, MIGRATIONS.filter((m) => m.version <= 3));
      seed.close();

      const first = new GraphStore(dbPath);
      expect(userVersion(rawDb(first))).toBe(4);
      first.close();

      // A second open must not attempt to re-add merged_from (which would
      // throw "duplicate column name").
      expect(() => {
        const second = new GraphStore(dbPath);
        try {
          expect(userVersion(rawDb(second))).toBe(4);
        } finally {
          second.close();
        }
      }).not.toThrow();
    });
  });

  describe("reopen idempotence", () => {
    it("reopening an already-migrated database is a no-op and stays at version 4", () => {
      const dbPath = tmpDbPath();

      const first = new GraphStore(dbPath);
      expect(userVersion(rawDb(first))).toBe(4);
      first.close();

      const second = new GraphStore(dbPath);
      try {
        expect(userVersion(rawDb(second))).toBe(4);
        expect(() => second.getProjects()).not.toThrow();
      } finally {
        second.close();
      }
    });

    it("reopening a database already upgraded from a V1 fixture does not re-run the migration", () => {
      const dbPath = tmpDbPath();
      const seed = new Database(dbPath);
      seed.exec(V1_DDL);
      seed.close();

      const first = new GraphStore(dbPath);
      expect(userVersion(rawDb(first))).toBe(4);
      first.close();

      // A second open must not attempt to re-add suppressed_count (which
      // would throw "duplicate column name") or re-create node_files/node_fts.
      expect(() => {
        const second = new GraphStore(dbPath);
        second.close();
      }).not.toThrow();
    });
  });
});

describe("runMigrations failure handling", () => {
  it("rolls back a failing migration (DDL included) and throws SojournMigrationError", () => {
    const db = new Database(":memory:");
    db.exec(V1_DDL); // V1 base schema, user_version 0

    const boom: Migration = {
      version: 2,
      description: "deliberately broken migration for tests",
      up(d) {
        // partial progress that must be rolled back
        d.exec(
          "CREATE TABLE node_files(node_id TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL)",
        );
        throw new Error("simulated failure mid-migration");
      },
    };

    expect(() => runMigrations(db, [boom])).toThrow(SojournMigrationError);
    expect(userVersion(db)).toBe(0);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'node_files'")
      .get();
    expect(table).toBeUndefined();
  });

  it("rolls back a failing migration on a file-backed WAL database, including fts5 shadow tables", () => {
    // The tests above use `new Database(":memory:")`, which defaults to
    // journal_mode=memory. Production GraphStore always opens a file-backed
    // db and forces journal_mode=WAL (mirrors applySchema in schema.ts).
    // Transactional DDL rollback semantics differ enough between journal
    // modes that this needs its own coverage — in particular, an fts5
    // virtual table creates several extra `sqlite_master` shadow tables
    // (e.g. `<name>_data`, `<name>_idx`, `<name>_docsize`, `<name>_config`)
    // that a rollback must also remove, not just the virtual table's own
    // entry.
    const dbPath = tmpDbPath();
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal"); // mirror applySchema
    db.exec(V1_DDL);

    const boom: Migration = {
      version: 2,
      description: "deliberately broken migration with partially-applied DDL (file-backed WAL)",
      up(d) {
        // partial progress that must be rolled back: a plain ALTER TABLE
        // plus a virtual table (fts5), both committed to sqlite_master
        // before the throw below aborts the migration.
        d.exec(`ALTER TABLE flags ADD COLUMN suppressed_count INTEGER NOT NULL DEFAULT 0`);
        d.exec(`CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, content);`);
        throw new Error("simulated failure mid-migration (file-backed WAL)");
      },
    };

    try {
      expect(() => runMigrations(db, [boom])).toThrow(SojournMigrationError);
      expect(userVersion(db)).toBe(0);

      // ALTER TABLE rolled back: suppressed_count column absent from flags.
      const flagCols = (
        db.prepare("PRAGMA table_info(flags)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      expect(flagCols).not.toContain("suppressed_count");

      // CREATE VIRTUAL TABLE rolled back: node_fts itself AND every fts5
      // shadow table it spawned (node_fts_data, node_fts_idx,
      // node_fts_docsize, node_fts_config, ...) are gone. A rollback that
      // only reverted the logical virtual-table entry but left its shadow
      // tables behind would fail this assertion.
      const leftover = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'node_fts' OR name LIKE 'node\\_fts\\_%' ESCAPE '\\'",
        )
        .all() as Array<{ name: string }>;
      expect(leftover).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("wraps the underlying cause and names the target version", () => {
    const db = new Database(":memory:");
    db.exec(V1_DDL);
    const originalError = new Error("root cause");
    const boom: Migration = {
      version: 2,
      description: "broken",
      up() {
        throw originalError;
      },
    };

    let caught: unknown;
    try {
      runMigrations(db, [boom]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SojournMigrationError);
    const migrationError = caught as SojournMigrationError;
    expect(migrationError.cause).toBe(originalError);
    expect(migrationError.version).toBe(2);
  });

  it("does not disturb the database when the very first migration fails on a fresh db", () => {
    const db = new Database(":memory:");
    db.exec(V1_DDL);

    const boom: Migration = {
      version: 2,
      description: "broken",
      up() {
        throw new Error("nope");
      },
    };

    expect(() => runMigrations(db, [boom])).toThrow(SojournMigrationError);
    // base V1 tables remain untouched and usable
    expect(() => db.prepare("SELECT * FROM projects").all()).not.toThrow();
    expect(userVersion(db)).toBe(0);
  });
});

describe("MIGRATIONS", () => {
  it("is the ordered list runMigrations uses by default, currently reaching version 4", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual([2, 3, 4]);
  });

  it("running the real list twice in a row is idempotent", () => {
    const db = new Database(":memory:");
    db.exec(V1_DDL);
    runMigrations(db);
    expect(userVersion(db)).toBe(4);
    expect(() => runMigrations(db)).not.toThrow();
    expect(userVersion(db)).toBe(4);
  });
});
