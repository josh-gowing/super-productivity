/**
 * SQLite implementation of {@link OpLogDbAdapter} — Phase B of the SQLite
 * migration (see docs/sync-and-op-log/sqlite-migration.md).
 *
 * STATUS: SKELETON. The DDL/SQL design below is complete and reviewable, but
 * the query methods are not implemented yet and the native plugin is not a
 * dependency. This file deliberately does NOT import
 * `@capacitor-community/sqlite`; it talks to the minimal {@link SqliteDb} port
 * so the adapter stays unit-testable (a fake `SqliteDb` in specs) and the
 * plugin choice is an isolated, on-device-testable change later.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Why a generic table model
 * ──────────────────────────────────────────────────────────────────────────
 * IndexedDB stores arbitrary structured-clone objects and extracts index keys
 * from value paths (e.g. `op.id`). SQLite has no nested columns, but the
 * op-log never needs to *query inside* an op — only by a handful of indexed
 * fields. So every store maps to a table with:
 *   - a primary key column (see below),
 *   - a `value` TEXT column holding the JSON-encoded object, and
 *   - one extracted column per IDB index, populated on write from the value.
 *
 * Primary key, by store kind (derived from {@link OpLogDbSchema}):
 *   - autoIncrement (`ops`): `seq INTEGER PRIMARY KEY AUTOINCREMENT`. AUTOINCREMENT
 *     (not bare INTEGER PRIMARY KEY) guarantees monotonic, never-reused seqs
 *     across `clear()` — matching IDB and what getLastSeq/lastAppliedOpSeq rely on.
 *   - keyPath stores (`state_cache`, `import_backup`, archive, `profile_data`):
 *     `key TEXT PRIMARY KEY`, value of `value -> '$.<keyPath>'` (e.g. `id`).
 *   - keyless singleton stores (`vector_clock`, `client_id`): `key TEXT PRIMARY
 *     KEY` supplied out-of-line by the caller (always SINGLETON_KEY today).
 *
 * Index columns (the only ones the op-log queries):
 *   - byId           → `op_id TEXT UNIQUE`         from `$.op.id`
 *   - bySyncedAt     → `synced_at INTEGER`         from `$.syncedAt`
 *   - bySourceStatus → `source TEXT, application_status TEXT` from `$.source`,
 *                      `$.applicationStatus` (compound index over the pair)
 * Nullable to match IDB, where entries missing an indexed path are simply not
 * present in that index (e.g. local ops have no `syncedAt`).
 *
 * Transactions: {@link transaction} maps to `BEGIN IMMEDIATE` … `COMMIT` /
 * `ROLLBACK` — real ACID, strictly stronger than IDB's auto-commit-on-
 * microtask-gap. Read scans use `mode:'readonly'` → a deferred/no write lock.
 *
 * Errors mapped to the domain types the rest of the system expects:
 *   - UNIQUE constraint on `op_id`  → the duplicate-op signal (callers map to
 *     DUPLICATE_OPERATION_ERROR_MSG), mirroring IDB's ConstraintError.
 *   - disk-full / SQLITE_FULL       → StorageQuotaExceededError.
 */

import {
  DbCursorVisitor,
  DbIterateOptions,
  DbKey,
  DbKeyRange,
  DbTxMode,
  OpLogDbAdapter,
  OpLogTx,
} from './op-log-db-adapter';
import { DbStoreSchema, OP_LOG_DB_SCHEMA, OpLogDbSchema } from './op-log-db-schema';

const NOT_IMPLEMENTED = (method: string): Error =>
  new Error(
    `SqliteOpLogAdapter.${method} not implemented yet (Phase B skeleton). ` +
      `See docs/sync-and-op-log/sqlite-migration.md.`,
  );

/** Column name carrying the JSON-encoded stored object. */
export const VALUE_COLUMN = 'value';
/** Primary-key column name for keyPath / keyless stores. */
export const KEY_COLUMN = 'key';

/**
 * Maps an IDB index keyPath to the generated SQL column(s) that back it.
 * The op-log only has these three indexes; the map is intentionally explicit
 * rather than auto-derived from arbitrary keyPaths, since the SQLite backend
 * needs to know the column TYPE and the `$.path` extraction per index.
 */
export interface SqlIndexColumn {
  /** SQL column name. */
  column: string;
  /** JSON path within the `value` column, e.g. `$.op.id`. */
  jsonPath: string;
  /** Column affinity. */
  type: 'TEXT' | 'INTEGER';
  unique?: boolean;
}

/** Per-store physical layout derived from a {@link DbStoreSchema}. */
export interface SqlTablePlan {
  table: string;
  /** 'autoinc' → INTEGER PK AUTOINCREMENT; 'key' → TEXT PK (keyPath/keyless). */
  primaryKey: 'autoinc' | 'key';
  /** For keyPath stores, the JSON path the PK is extracted from (e.g. `$.id`). */
  keyJsonPath?: string;
  indexColumns: SqlIndexColumn[];
}

/**
 * Minimal async SQLite surface this adapter needs. A thin wrapper over
 * `@capacitor-community/sqlite`'s `SQLiteDBConnection` will satisfy it; tests
 * provide a fake. Kept here (not imported from the plugin) so this file has no
 * native dependency.
 */
export interface SqliteDb {
  /** Run a statement with no result set (DDL, INSERT/UPDATE/DELETE). */
  run(sql: string, params?: unknown[]): Promise<{ changes: number; lastId?: number }>;
  /** Run a query, returning rows as plain objects. */
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * Known index keyPath → column mapping for the `ops` store, keyed by the value
 * path the IDB index uses. A list (not an object literal) so dotted paths like
 * `op.id` aren't constrained by identifier naming rules.
 */
const OPS_INDEX_COLUMNS: ReadonlyArray<SqlIndexColumn & { keyPath: string }> = [
  { keyPath: 'op.id', column: 'op_id', jsonPath: '$.op.id', type: 'TEXT', unique: true },
  { keyPath: 'syncedAt', column: 'synced_at', jsonPath: '$.syncedAt', type: 'INTEGER' },
  // The compound [source, applicationStatus] index becomes two columns plus a
  // composite index; handled specially in planning below.
  { keyPath: 'source', column: 'source', jsonPath: '$.source', type: 'TEXT' },
  {
    keyPath: 'applicationStatus',
    column: 'application_status',
    jsonPath: '$.applicationStatus',
    type: 'TEXT',
  },
];

const opsIndexColumnFor = (keyPath: string): SqlIndexColumn | undefined => {
  const match = OPS_INDEX_COLUMNS.find((c) => c.keyPath === keyPath);
  if (!match) {
    return undefined;
  }
  const { column, jsonPath, type, unique } = match;
  return { column, jsonPath, type, unique };
};

/**
 * Derive a physical {@link SqlTablePlan} for each store from the engine-agnostic
 * {@link OpLogDbSchema}. This is the bridge that lets the same descriptor drive
 * both the IndexedDB upgrade and the SQLite DDL.
 */
export const planTables = (schema: OpLogDbSchema = OP_LOG_DB_SCHEMA): SqlTablePlan[] =>
  schema.stores.map((store) => planTable(store));

const planTable = (store: DbStoreSchema): SqlTablePlan => {
  const indexColumns: SqlIndexColumn[] = [];
  for (const idx of store.indexes ?? []) {
    const paths = Array.isArray(idx.keyPath) ? idx.keyPath : [idx.keyPath];
    for (const path of paths) {
      const col = opsIndexColumnFor(path);
      if (col) {
        // Preserve uniqueness only for single-column unique indexes.
        indexColumns.push(
          idx.unique && paths.length === 1 ? { ...col, unique: true } : col,
        );
      }
    }
  }
  return {
    table: store.name,
    primaryKey: store.autoIncrement ? 'autoinc' : 'key',
    keyJsonPath: store.keyPath ? `$.${store.keyPath}` : undefined,
    indexColumns,
  };
};

/**
 * Build the `CREATE TABLE` + `CREATE INDEX` DDL for a planned table. Pure and
 * dependency-free so it can be unit-tested without a database.
 */
export const buildDdl = (plan: SqlTablePlan): string[] => {
  const cols: string[] = [];
  if (plan.primaryKey === 'autoinc') {
    cols.push('seq INTEGER PRIMARY KEY AUTOINCREMENT');
  } else {
    cols.push(`${KEY_COLUMN} TEXT PRIMARY KEY`);
  }
  cols.push(`${VALUE_COLUMN} TEXT NOT NULL`);
  for (const ic of plan.indexColumns) {
    cols.push(`${ic.column} ${ic.type}`);
  }
  const ddl: string[] = [`CREATE TABLE IF NOT EXISTS ${plan.table} (${cols.join(', ')})`];
  // Single-column unique index (byId).
  for (const ic of plan.indexColumns) {
    if (ic.unique) {
      ddl.push(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_${plan.table}_${ic.column} ` +
          `ON ${plan.table}(${ic.column})`,
      );
    }
  }
  // Non-unique single index (bySyncedAt) and the composite (source, status).
  const nonUnique = plan.indexColumns.filter((c) => !c.unique);
  if (nonUnique.some((c) => c.column === 'synced_at')) {
    ddl.push(
      `CREATE INDEX IF NOT EXISTS idx_${plan.table}_synced_at ` +
        `ON ${plan.table}(synced_at)`,
    );
  }
  if (
    nonUnique.some((c) => c.column === 'source') &&
    nonUnique.some((c) => c.column === 'application_status')
  ) {
    ddl.push(
      `CREATE INDEX IF NOT EXISTS idx_${plan.table}_source_status ` +
        `ON ${plan.table}(source, application_status)`,
    );
  }
  return ddl;
};

/**
 * SQLite-backed {@link OpLogDbAdapter}.
 *
 * NOTE: query methods are not implemented yet — only the schema planning/DDL
 * (above) and the lifecycle wiring are. They throw {@link NOT_IMPLEMENTED} so
 * an accidental wiring on native fails loudly rather than silently losing data.
 * `adoptConnection` is intentionally absent (undefined): SQLite self-manages
 * its handle; the stores' `adoptConnection?.()` calls are no-ops here.
 */
export class SqliteOpLogAdapter implements OpLogDbAdapter {
  private _plans: SqlTablePlan[];

  constructor(
    private readonly _db: SqliteDb,
    private readonly _schema: OpLogDbSchema = OP_LOG_DB_SCHEMA,
  ) {
    this._plans = planTables(_schema);
  }

  async init(): Promise<void> {
    // Apply DDL for every store. Idempotent via `IF NOT EXISTS`. Phase C will
    // add the one-time IDB→SQLite data copy ahead of first use.
    for (const plan of this._plans) {
      for (const stmt of buildDdl(plan)) {
        await this._db.run(stmt);
      }
    }
  }

  close(): void {
    // The owning connection lifecycle (open/close) is managed by whoever
    // constructs the SqliteDb; nothing cached here to drop yet.
  }

  // ── single-store ops (not implemented — SQL shape documented per method) ───

  async add(_store: string, _value: unknown): Promise<number> {
    // INSERT INTO <t>(value, <index cols...>) VALUES(json(?), <extracted...>)
    // RETURNING seq;  — UNIQUE(op_id) violation → duplicate-op error.
    throw NOT_IMPLEMENTED('add');
  }

  async put(_store: string, _value: unknown, _key?: DbKey): Promise<void> {
    // INSERT INTO <t>(key, value, <cols>) VALUES(?, json(?), ...)
    //   ON CONFLICT(key) DO UPDATE SET value=excluded.value, <cols=excluded...>
    throw NOT_IMPLEMENTED('put');
  }

  async get<T>(_store: string, _key: DbKey): Promise<T | undefined> {
    // SELECT value FROM <t> WHERE key = ?  → JSON.parse(value)
    throw NOT_IMPLEMENTED('get');
  }

  async getAll<T>(_store: string, _range?: DbKeyRange): Promise<T[]> {
    // SELECT value FROM <t> [WHERE <pk> BETWEEN ? AND ?] ORDER BY <pk>
    throw NOT_IMPLEMENTED('getAll');
  }

  async delete(_store: string, _key: DbKey): Promise<void> {
    // DELETE FROM <t> WHERE key = ?
    throw NOT_IMPLEMENTED('delete');
  }

  async clear(_store: string): Promise<void> {
    // DELETE FROM <t>
    throw NOT_IMPLEMENTED('clear');
  }

  async count(_store: string, _range?: DbKeyRange): Promise<number> {
    // SELECT COUNT(*) FROM <t> [WHERE <pk> BETWEEN ? AND ?]
    throw NOT_IMPLEMENTED('count');
  }

  async getFromIndex<T>(
    _store: string,
    _index: string,
    _key: DbKey | DbKey[],
  ): Promise<T | undefined> {
    // SELECT value FROM <t> WHERE <indexcol(s)> = ? LIMIT 1
    throw NOT_IMPLEMENTED('getFromIndex');
  }

  async getKeyFromIndex(
    _store: string,
    _index: string,
    _key: DbKey | DbKey[],
  ): Promise<DbKey | undefined> {
    // SELECT seq FROM <t> WHERE <indexcol(s)> = ? LIMIT 1
    throw NOT_IMPLEMENTED('getKeyFromIndex');
  }

  async getAllFromIndex<T>(
    _store: string,
    _index: string,
    _range?: DbKeyRange,
  ): Promise<T[]> {
    // SELECT value FROM <t> WHERE <indexcol(s)> [= ? | BETWEEN ? AND ?]
    throw NOT_IMPLEMENTED('getAllFromIndex');
  }

  async countFromIndex(
    _store: string,
    _index: string,
    _range?: DbKeyRange,
  ): Promise<number> {
    // SELECT COUNT(*) FROM <t> WHERE <indexcol(s)> [= ? | BETWEEN ? AND ?]
    throw NOT_IMPLEMENTED('countFromIndex');
  }

  async iterate<T>(
    _store: string,
    _options: DbIterateOptions,
    _visit: DbCursorVisitor<T>,
  ): Promise<void> {
    // SELECT seq, value FROM <t> [WHERE ...] ORDER BY <pk|index> [DESC];
    // call visit() per row (honoring stop/delete/delete-stop); collect
    // delete keys and DELETE them in the same transaction.
    throw NOT_IMPLEMENTED('iterate');
  }

  async transaction<T>(
    _stores: string[],
    _mode: DbTxMode,
    _fn: (tx: OpLogTx) => Promise<T>,
  ): Promise<T> {
    // BEGIN IMMEDIATE; run fn with an OpLogTx bound to this connection;
    // COMMIT on resolve, ROLLBACK on throw, then rethrow (mapping SQLITE_FULL
    // → StorageQuotaExceededError). Same commit-on-resolve / abort-on-throw
    // contract as the IndexedDB backend.
    throw NOT_IMPLEMENTED('transaction');
  }
}
