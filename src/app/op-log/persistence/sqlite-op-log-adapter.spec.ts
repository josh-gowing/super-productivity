import {
  buildDdl,
  planTables,
  SqliteDb,
  SqliteOpLogAdapter,
} from './sqlite-op-log-adapter';
import { OpLogDbAdapter } from './op-log-db-adapter';
import { STORE_NAMES, OPS_INDEXES, DB_NAME } from './db-keys.const';

/**
 * Covers the dependency-free parts of the SQLite skeleton: the schema -> table
 * plan derivation, the DDL it generates, and that init() applies that DDL to
 * the SqliteDb port. The query methods are intentionally unimplemented (Phase
 * B) and asserted to throw loudly rather than silently lose data.
 */
describe('SqliteOpLogAdapter (skeleton)', () => {
  describe('planTables', () => {
    const plans = planTables();
    const byTable = (t: string): ReturnType<typeof planTables>[number] =>
      plans.find((p) => p.table === t)!;

    it('plans one table per store in the schema', () => {
      expect(plans.map((p) => p.table).sort()).toEqual(Object.values(STORE_NAMES).sort());
    });

    it('maps the autoincrement ops store to an autoinc primary key', () => {
      expect(byTable(STORE_NAMES.OPS).primaryKey).toBe('autoinc');
    });

    it('maps keyPath stores to a TEXT key extracted from their keyPath', () => {
      const sc = byTable(STORE_NAMES.STATE_CACHE);
      expect(sc.primaryKey).toBe('key');
      expect(sc.keyJsonPath).toBe('$.id');
    });

    it('maps keyless singleton stores to a caller-supplied TEXT key', () => {
      const vc = byTable(STORE_NAMES.VECTOR_CLOCK);
      expect(vc.primaryKey).toBe('key');
      expect(vc.keyJsonPath).toBeUndefined();
    });

    it('derives ops index columns including the unique byId and the compound pair', () => {
      const ops = byTable(STORE_NAMES.OPS);
      const cols = ops.indexColumns.map((c) => c.column);
      expect(cols).toContain('op_id');
      expect(cols).toContain('synced_at');
      expect(cols).toContain('source');
      expect(cols).toContain('application_status');
      const opId = ops.indexColumns.find((c) => c.column === 'op_id')!;
      expect(opId.unique).toBe(true);
      // The compound [source, applicationStatus] members are NOT unique.
      expect(ops.indexColumns.find((c) => c.column === 'source')!.unique).toBeFalsy();
    });
  });

  describe('buildDdl', () => {
    const opsDdl = buildDdl(planTables().find((p) => p.table === STORE_NAMES.OPS)!);

    it('creates the ops table with an AUTOINCREMENT seq and a JSON value column', () => {
      const create = opsDdl.find((s) => s.startsWith('CREATE TABLE'))!;
      expect(create).toContain('seq INTEGER PRIMARY KEY AUTOINCREMENT');
      expect(create).toContain('value TEXT NOT NULL');
    });

    it('emits a UNIQUE index for byId and a composite index for source+status', () => {
      expect(opsDdl.some((s) => /CREATE UNIQUE INDEX.*op_id/.test(s))).toBeTrue();
      expect(
        opsDdl.some((s) => /CREATE INDEX.*\(source, application_status\)/.test(s)),
      ).toBeTrue();
    });

    it('keyPath stores get a TEXT primary key, no autoincrement', () => {
      const sc = buildDdl(planTables().find((p) => p.table === STORE_NAMES.STATE_CACHE)!);
      const create = sc.find((s) => s.startsWith('CREATE TABLE'))!;
      expect(create).toContain('key TEXT PRIMARY KEY');
      expect(create).not.toContain('AUTOINCREMENT');
    });

    it('uses OPS_INDEXES / DB_NAME from the shared schema (no drift)', () => {
      // Sanity: the descriptor the plan came from is the real SUP_OPS schema.
      expect(DB_NAME).toBe('SUP_OPS');
      expect(Object.values(OPS_INDEXES)).toContain('byId');
    });
  });

  describe('init', () => {
    it('applies every DDL statement to the SqliteDb', async () => {
      const run = jasmine.createSpy('run').and.resolveTo({ changes: 0 });
      const fakeDb: SqliteDb = { run, query: async () => [] };

      const adapter = new SqliteOpLogAdapter(fakeDb);
      await adapter.init();

      const statements = run.calls.allArgs().map((args) => args[0] as string);
      // One CREATE TABLE per store, plus the ops indexes.
      expect(statements.filter((s) => s.startsWith('CREATE TABLE')).length).toBe(
        Object.values(STORE_NAMES).length,
      );
      expect(statements.some((s) => /CREATE UNIQUE INDEX.*op_id/.test(s))).toBeTrue();
    });
  });

  describe('unimplemented query methods', () => {
    const adapter = new SqliteOpLogAdapter({
      run: async () => ({ changes: 0 }),
      query: async () => [],
    });

    it('throws a clear not-implemented error rather than silently no-op', async () => {
      await expectAsync(adapter.get('ops', 1)).toBeRejectedWithError(
        /not implemented yet/i,
      );
      await expectAsync(
        adapter.transaction(['ops'], 'readwrite', async () => undefined),
      ).toBeRejectedWithError(/not implemented yet/i);
    });

    it('does not implement adoptConnection (SQLite self-manages its handle)', () => {
      // adoptConnection is an optional interface member; SQLite leaves it unset.
      expect((adapter as OpLogDbAdapter).adoptConnection).toBeUndefined();
    });
  });
});
