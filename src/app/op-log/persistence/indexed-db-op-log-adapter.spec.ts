import 'fake-indexeddb/auto';
import { IndexedDbOpLogAdapter } from './indexed-db-op-log-adapter';
import { OP_LOG_DB_SCHEMA } from './op-log-db-schema';
import { STORE_NAMES, OPS_INDEXES, SINGLETON_KEY } from './db-keys.const';
import { DbCursorAction } from './op-log-db-adapter';

/**
 * Verifies IndexedDbOpLogAdapter against a real (faked) IndexedDB: CRUD,
 * indexes/ranges, cursor iteration semantics, and — most importantly —
 * transaction atomicity (commit on resolve, roll back on throw), which is the
 * load-bearing guarantee both backends must share.
 */
describe('IndexedDbOpLogAdapter', () => {
  let adapter: IndexedDbOpLogAdapter;

  const makeOpEntry = (
    id: string,
    source: 'local' | 'remote',
    applicationStatus?: 'pending' | 'applied' | 'failed',
    syncedAt?: number,
  ): Record<string, unknown> => ({
    op: { id },
    appliedAt: Date.now(),
    source,
    syncedAt,
    applicationStatus,
  });

  beforeEach(async () => {
    adapter = new IndexedDbOpLogAdapter();
    await adapter.init();
  });

  afterEach(async () => {
    adapter.close();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(OP_LOG_DB_SCHEMA.name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });

  it('add() auto-increments seq and get() round-trips by key', async () => {
    const seq1 = await adapter.add(STORE_NAMES.OPS, makeOpEntry('a', 'local'));
    const seq2 = await adapter.add(STORE_NAMES.OPS, makeOpEntry('b', 'local'));
    expect(seq2).toBe(seq1 + 1);

    const got = await adapter.get<{ op: { id: string } }>(STORE_NAMES.OPS, seq1);
    expect(got?.op.id).toBe('a');
  });

  it('put()/get() works for keyless singleton stores (explicit out-of-line key)', async () => {
    await adapter.put(
      STORE_NAMES.VECTOR_CLOCK,
      { clock: { client1: 3 }, lastUpdate: 1 },
      SINGLETON_KEY,
    );
    const vc = await adapter.get<{ clock: Record<string, number> }>(
      STORE_NAMES.VECTOR_CLOCK,
      SINGLETON_KEY,
    );
    expect(vc?.clock['client1']).toBe(3);
  });

  it('enforces the unique byId index (duplicate op.id rejects)', async () => {
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('dup', 'local'));
    await expectAsync(
      adapter.add(STORE_NAMES.OPS, makeOpEntry('dup', 'local')),
    ).toBeRejected();
  });

  it('getFromIndex(byId) finds the entry regardless of seq', async () => {
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('x', 'local'));
    const entry = await adapter.getFromIndex<{ op: { id: string } }>(
      STORE_NAMES.OPS,
      OPS_INDEXES.BY_ID,
      'x',
    );
    expect(entry?.op.id).toBe('x');
  });

  it('getAllFromIndex with a lowerBound range filters by seq', async () => {
    const s1 = await adapter.add(
      STORE_NAMES.OPS,
      makeOpEntry('a', 'local', undefined, 10),
    );
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('b', 'local', undefined, 20));
    // bySyncedAt index, only entries with syncedAt > s1's value
    const res = await adapter.getAllFromIndex<{ op: { id: string } }>(
      STORE_NAMES.OPS,
      OPS_INDEXES.BY_SYNCED_AT,
      { lower: 10, lowerOpen: true },
    );
    expect(res.map((r) => r.op.id)).toEqual(['b']);
    expect(s1).toBeGreaterThan(0);
  });

  it('iterate(prev) visits in descending key order and stops on demand', async () => {
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('a', 'local'));
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('b', 'local'));
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('c', 'local'));

    const visited: string[] = [];
    await adapter.iterate<{ op: { id: string } }>(
      STORE_NAMES.OPS,
      { direction: 'prev' },
      (v) => {
        visited.push(v.op.id);
        return 'stop' as DbCursorAction;
      },
    );
    expect(visited).toEqual(['c']); // latest first, stopped immediately
  });

  it("iterate with 'delete' prunes matching entries and keeps going", async () => {
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('keep1', 'local'));
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('drop', 'remote'));
    await adapter.add(STORE_NAMES.OPS, makeOpEntry('keep2', 'local'));

    await adapter.iterate<{ op: { id: string }; source: string }>(
      STORE_NAMES.OPS,
      {},
      (v) => (v.source === 'remote' ? 'delete' : 'continue') as DbCursorAction,
    );

    const remaining = await adapter.getAll<{ op: { id: string } }>(STORE_NAMES.OPS);
    expect(remaining.map((r) => r.op.id).sort()).toEqual(['keep1', 'keep2']);
  });

  describe('transaction()', () => {
    it('commits a multi-store write atomically', async () => {
      await adapter.transaction(
        [STORE_NAMES.OPS, STORE_NAMES.VECTOR_CLOCK],
        'readwrite',
        async (tx) => {
          await tx.add(STORE_NAMES.OPS, makeOpEntry('tx', 'local'));
          await tx.put(
            STORE_NAMES.VECTOR_CLOCK,
            { clock: { c: 1 }, lastUpdate: 1 },
            SINGLETON_KEY,
          );
        },
      );

      const op = await adapter.getFromIndex(STORE_NAMES.OPS, OPS_INDEXES.BY_ID, 'tx');
      const vc = await adapter.get(STORE_NAMES.VECTOR_CLOCK, SINGLETON_KEY);
      expect(op).toBeTruthy();
      expect(vc).toBeTruthy();
    });

    it('rolls back ALL writes when the body throws (no partial commit)', async () => {
      // Seed one row so we can prove the clear() inside the tx is undone too.
      await adapter.put(
        STORE_NAMES.VECTOR_CLOCK,
        { clock: { seed: 9 }, lastUpdate: 0 },
        SINGLETON_KEY,
      );

      await expectAsync(
        adapter.transaction(
          [STORE_NAMES.OPS, STORE_NAMES.VECTOR_CLOCK],
          'readwrite',
          async (tx) => {
            await tx.add(STORE_NAMES.OPS, makeOpEntry('shouldVanish', 'local'));
            await tx.put(
              STORE_NAMES.VECTOR_CLOCK,
              { clock: { changed: 1 }, lastUpdate: 1 },
              SINGLETON_KEY,
            );
            throw new Error('boom');
          },
        ),
      ).toBeRejectedWithError('boom');

      // OPS write rolled back...
      const op = await adapter.getFromIndex(
        STORE_NAMES.OPS,
        OPS_INDEXES.BY_ID,
        'shouldVanish',
      );
      expect(op).toBeUndefined();
      // ...and the vector clock still holds the seeded value, not the aborted one.
      const vc = await adapter.get<{ clock: Record<string, number> }>(
        STORE_NAMES.VECTOR_CLOCK,
        SINGLETON_KEY,
      );
      expect(vc?.clock['seed']).toBe(9);
    });
  });

  it('init() is idempotent under concurrent callers', async () => {
    const fresh = new IndexedDbOpLogAdapter();
    await Promise.all([fresh.init(), fresh.init(), fresh.init()]);
    // A working DB after concurrent init proves no double-open/upgrade crash.
    const seq = await fresh.add(STORE_NAMES.OPS, makeOpEntry('concurrent', 'local'));
    expect(seq).toBeGreaterThan(0);
    fresh.close();
  });
});
