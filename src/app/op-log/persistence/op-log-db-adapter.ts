/**
 * Backend-agnostic persistence port for the op-log subsystem.
 *
 * Phase A of the SQLite migration (see docs/sync-and-op-log/sqlite-migration.md).
 * The op-log store currently talks to `idb` directly; this port lets the same
 * store run over either IndexedDB (web/PWA/Electron) or native SQLite
 * (Capacitor iOS/Android) without leaking either engine's semantics.
 *
 * Design constraints captured from the existing IndexedDB store:
 * - `ops` uses an auto-increment integer key (`seq`), a UNIQUE index on
 *   `op.id` (`byId`), a plain index on `syncedAt`, and a compound index on
 *   `[source, applicationStatus]`.
 * - Singleton stores (`vector_clock`, `client_id`, `state_cache`,
 *   `import_backup`, archive) are keyed by a known string key.
 * - Two flows require atomic multi-store writes:
 *   `appendWithVectorClockUpdate` (OPS + VECTOR_CLOCK) and
 *   `runDestructiveStateReplacement` (OPS + STATE_CACHE + VECTOR_CLOCK +
 *   CLIENT_ID + archive). Hence the callback-based {@link transaction}: commit
 *   on resolve, roll back on throw — the one shape both IDB auto-commit and
 *   SQLite BEGIN/COMMIT map onto cleanly.
 */

/** A value usable as a primary key in either backend. */
export type DbKey = string | number;

/** Half-open range query against an index (mirrors IDBKeyRange usage). */
export interface DbKeyRange {
  lower?: DbKey | DbKey[];
  upper?: DbKey | DbKey[];
  lowerOpen?: boolean;
  upperOpen?: boolean;
}

export type DbTxMode = 'readonly' | 'readwrite';

/**
 * Operations available inside a {@link OpLogDbAdapter.transaction} callback.
 *
 * Scoped to the stores requested when the transaction was opened. The
 * implementation guarantees every call here participates in the same atomic
 * unit: if the callback throws (or any call rejects) nothing is committed.
 */
export interface OpLogTx {
  /** Insert a value into an auto-increment store; resolves to the new key. */
  add(store: string, value: unknown): Promise<number>;
  /** Insert/replace a value, optionally at an explicit key (for keyless stores). */
  put(store: string, value: unknown, key?: DbKey): Promise<void>;
  get<T>(store: string, key: DbKey): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  delete(store: string, key: DbKey): Promise<void>;
  clear(store: string): Promise<void>;
  getFromIndex<T>(
    store: string,
    index: string,
    key: DbKey | DbKey[],
  ): Promise<T | undefined>;
  getAllFromIndex<T>(store: string, index: string, range?: DbKeyRange): Promise<T[]>;
}

/**
 * The persistence backend. One instance owns one logical database (`SUP_OPS`).
 *
 * Non-transactional methods are convenience single-store operations (each runs
 * in its own implicit transaction); use {@link transaction} whenever two or
 * more writes must be atomic.
 */
export interface OpLogDbAdapter {
  /**
   * Open/create the database against {@link OpLogDbSchema}. Idempotent: safe to
   * call concurrently; implementations dedupe via an in-flight promise.
   */
  init(): Promise<void>;

  add(store: string, value: unknown): Promise<number>;
  put(store: string, value: unknown, key?: DbKey): Promise<void>;
  get<T>(store: string, key: DbKey): Promise<T | undefined>;
  getAll<T>(store: string): Promise<T[]>;
  delete(store: string, key: DbKey): Promise<void>;
  clear(store: string): Promise<void>;

  getFromIndex<T>(
    store: string,
    index: string,
    key: DbKey | DbKey[],
  ): Promise<T | undefined>;
  getAllFromIndex<T>(store: string, index: string, range?: DbKeyRange): Promise<T[]>;
  countFromIndex(store: string, index: string, range?: DbKeyRange): Promise<number>;

  /**
   * Run `fn` as a single atomic transaction over `stores`. The transaction
   * commits when the returned promise resolves and rolls back if it rejects.
   * Only the listed stores may be touched via the provided {@link OpLogTx}.
   */
  transaction<T>(
    stores: string[],
    mode: DbTxMode,
    fn: (tx: OpLogTx) => Promise<T>,
  ): Promise<T>;
}
