import type BetterSqlite3 from "better-sqlite3";

/**
 * Schema migration framework for the Sojourn graph store.
 *
 * `PRAGMA user_version` is the single source of truth for "which schema
 * shape does this file have". `schema.ts` owns the one-time bootstrap DDL
 * (the shape V1 shipped with, which never stamped `user_version` — every
 * V1 database therefore reads back as version 0). From V2 onward, ALL
 * structural changes — new columns, new tables, new indexes — flow
 * through the ordered `MIGRATIONS` list below and nowhere else. Do not
 * add new tables/columns to `schema.ts`; add a migration instead.
 *
 * ## Fresh vs. upgraded databases
 *
 * `GraphStore`'s constructor always runs `applySchema(db)` (idempotent:
 * `CREATE TABLE IF NOT EXISTS`) before `runMigrations(db)`. That means by
 * the time `runMigrations` runs, the V1 base tables
 * (projects/sessions/nodes/flags/annotations) are guaranteed to exist —
 * whether the file was byte-empty a moment ago or was already a
 * populated V1 database. Both cases report `user_version = 0`, because
 * V1 never touched that pragma. There is therefore no meaningful
 * distinction between "v0" and "v1" from the migration runner's point of
 * view: both are the same starting shape (V1 base schema, version 0),
 * and the *same* ordered list of migrations bridges either one forward
 * to the current version. This is why a single migration entry (targeting
 * version 2) is correct for both a brand-new `:memory:` store and a
 * real V1 database fixture — "treat a fresh schema as v-current-base" in
 * practice means "the bootstrap DDL already put us on the version-0
 * baseline; walk forward from there like anything else would."
 *
 * ## Adding a migration later
 *
 * Append a new `{ version, description, up }` entry with the next
 * integer version. `up` receives the raw `better-sqlite3` handle and
 * should only run DDL/DML for that one step — `runMigrations` wraps each
 * step in its own transaction and stamps `user_version` to that step's
 * version only after `up` returns without throwing.
 */
export interface Migration {
  /** Target `user_version` this migration advances the database to. */
  readonly version: number;
  /** Human-readable summary, surfaced in error messages. */
  readonly description: string;
  /** Mutates `db` to bring it from `version - 1` (or any earlier version) to `version`. */
  up(db: BetterSqlite3.Database): void;
}

/**
 * Stable machine-readable classification is deliberately omitted here —
 * unlike restore errors, there is only one failure mode (a migration
 * step threw). Consumers should inspect `.version` and `.cause`.
 */
export class SojournMigrationError extends Error {
  /** The version the failed migration was trying to reach. */
  readonly version: number;

  constructor(message: string, version: number, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SojournMigrationError";
    this.version = version;
  }
}

/**
 * v2: adds `flags.suppressed_count` (flag-budget digest rollups, Task 2),
 * `node_files` (per-turn file index, populated by Task 8), and `node_fts`
 * (FTS5 full-text index, populated by Task 8). This task ships the empty
 * structures + framework only — population happens in later tasks.
 */
const V2_MIGRATION: Migration = {
  version: 2,
  description:
    "add flags.suppressed_count, node_files table, and node_fts FTS5 table",
  up(db) {
    db.exec(`ALTER TABLE flags ADD COLUMN suppressed_count INTEGER NOT NULL DEFAULT 0`);
    db.exec(`
      CREATE TABLE node_files(
        node_id TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
    db.exec(`CREATE INDEX idx_node_files_path ON node_files(path);`);
    db.exec(`CREATE INDEX idx_node_files_node ON node_files(node_id);`);
    // Contentless-ok: this table ships empty in v2 (Task 8 populates it on
    // upsertNode/addAnnotation). node_id is UNINDEXED — it's a join key,
    // not searched text.
    db.exec(`CREATE VIRTUAL TABLE node_fts USING fts5(node_id UNINDEXED, content);`);
  },
};

/**
 * v3: adds `nodes.rewind_of` — the rewind-provenance edge (must-fix I3).
 * A session synthesized by restore/rewind is parented to the node it was
 * rewound to, and `rewind_of` records that edge on the session's root
 * (mirroring `forked_from` for worktree-aliased sessions).
 */
const V3_MIGRATION: Migration = {
  version: 3,
  description: "add nodes.rewind_of (rewind-synthesized session provenance edge)",
  up(db) {
    db.exec(`ALTER TABLE nodes ADD COLUMN rewind_of TEXT`);
  },
};

/**
 * Ordered migration list. Keep ascending by `version` with no gaps or
 * duplicates — `runMigrations` sorts defensively but does not validate
 * contiguity.
 */
export const MIGRATIONS: readonly Migration[] = [V2_MIGRATION, V3_MIGRATION];

function currentVersion(db: BetterSqlite3.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function applyMigration(db: BetterSqlite3.Database, migration: Migration): void {
  const run = db.transaction(() => {
    migration.up(db);
    // PRAGMA user_version writes participate in the enclosing transaction
    // (it's part of the database header page) — if `up` throws above,
    // this line never runs, and if we throw after it, the whole
    // transaction — DDL included — rolls back together.
    db.pragma(`user_version = ${migration.version}`);
  });
  try {
    run();
  } catch (cause) {
    throw new SojournMigrationError(
      `migration to version ${migration.version} ("${migration.description}") failed and was rolled back`,
      migration.version,
      cause,
    );
  }
}

/**
 * Brings `db` forward to the latest known schema version, running only
 * the migrations still missing (`version > current user_version`), each
 * in its own transaction. Idempotent: a database already at the latest
 * version is a no-op. On failure, the failing step's transaction rolls
 * back in full (DDL included) and `user_version` is left exactly where
 * it was before that step started; earlier, already-committed steps in
 * this same call are NOT rolled back.
 *
 * `migrations` defaults to the real `MIGRATIONS` list; tests may pass a
 * substitute list (e.g. containing a deliberately-throwing step) without
 * mutating the shared list.
 */
export function runMigrations(
  db: BetterSqlite3.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  let version = currentVersion(db);
  for (const migration of ordered) {
    if (migration.version <= version) continue;
    applyMigration(db, migration);
    version = migration.version;
  }
}
