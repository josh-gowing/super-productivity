/**
 * Regression test for issue #7700.
 *
 * Pre-fix bug:
 *   1. RemoteOpsProcessingService acquires the `sp_op_log` lock.
 *   2. Inside the lock, it calls OperationApplierService.applyOperations.
 *   3. applyOperations delegated to replayOperationBatch which always called
 *      OperationLogEffects.processDeferredActions in its finally block.
 *   4. processDeferredActions -> writeOperation re-requested `sp_op_log`.
 *   5. Web Locks are not reentrant. The inner request blocks until the 30s
 *      LockService timeout, surfaced to the user as "Failed to sync".
 *
 * Both tests in this spec use the REAL LockService, not a mock — the existing
 * operation-log.effects.spec replaces lockService.request with an inline
 * callback runner and therefore cannot expose the deadlock.
 */
import { TestBed } from '@angular/core/testing';
import { provideMockActions } from '@ngrx/effects/testing';
import { Action, Store } from '@ngrx/store';
import { Observable, of } from 'rxjs';
import { OperationLogEffects } from '../capture/operation-log.effects';
import { OperationLogStoreService } from '../persistence/operation-log-store.service';
import { LockService } from './lock.service';
import { VectorClockService } from './vector-clock.service';
import { OperationLogCompactionService } from '../persistence/operation-log-compaction.service';
import { SnackService } from '../../core/snack/snack.service';
import { ImmediateUploadService } from '../sync/immediate-upload.service';
import { ActionType, OpType } from '../core/operation.types';
import { PersistentAction } from '../core/persistent-action.interface';
import {
  bufferDeferredAction,
  clearDeferredActions,
} from '../capture/operation-capture.meta-reducer';
import { ClientIdService } from '../../core/util/client-id.service';
import { OperationCaptureService } from '../capture/operation-capture.service';
import { LOCK_NAMES } from '../core/operation-log.const';
import { LockAcquisitionTimeoutError } from '../core/errors/sync-errors';
import { SuperSyncStatusService } from './super-sync-status.service';

describe('regression #7700: operation-log lock reentry', () => {
  let effects: OperationLogEffects;
  let lockService: LockService;
  const actions$: Observable<Action> = of();
  let opLogStoreSpy: jasmine.SpyObj<OperationLogStoreService>;

  const createDeferredAction = (): PersistentAction => ({
    type: ActionType.TASK_SHARED_UPDATE,
    meta: {
      isPersistent: true,
      isRemote: false,
      opType: OpType.Update,
      entityType: 'TASK',
      entityId: 'task-1',
    },
  });

  beforeEach(() => {
    opLogStoreSpy = jasmine.createSpyObj('OperationLogStoreService', [
      'appendWithVectorClockUpdate',
      'getCompactionCounter',
      'clearVectorClockCache',
    ]);
    opLogStoreSpy.appendWithVectorClockUpdate.and.resolveTo(1);
    opLogStoreSpy.getCompactionCounter.and.resolveTo(0);

    const vectorClockSpy = jasmine.createSpyObj('VectorClockService', [
      'getCurrentVectorClock',
    ]);
    vectorClockSpy.getCurrentVectorClock.and.resolveTo({ testClient: 5 });

    const compactionSpy = jasmine.createSpyObj('OperationLogCompactionService', [
      'compact',
      'emergencyCompact',
    ]);
    compactionSpy.compact.and.resolveTo();
    compactionSpy.emergencyCompact.and.resolveTo(true);

    const snackSpy = jasmine.createSpyObj('SnackService', ['open']);
    const storeSpy = jasmine.createSpyObj('Store', ['dispatch', 'select']);
    storeSpy.select.and.returnValue(of({}));

    const immediateUploadSpy = jasmine.createSpyObj('ImmediateUploadService', [
      'trigger',
    ]);
    const clientIdSpy = jasmine.createSpyObj('ClientIdService', ['loadClientId']);
    clientIdSpy.loadClientId.and.resolveTo('testClient');

    const operationCaptureSpy = jasmine.createSpyObj('OperationCaptureService', [
      'dequeue',
    ]);
    operationCaptureSpy.dequeue.and.returnValue([]);

    const superSyncStatusSpy = jasmine.createSpyObj('SuperSyncStatusService', [
      'updatePendingOpsStatus',
    ]);

    TestBed.configureTestingModule({
      providers: [
        OperationLogEffects,
        // NOTE: real LockService — required to exercise reentrancy semantics.
        LockService,
        provideMockActions(() => actions$),
        { provide: OperationLogStoreService, useValue: opLogStoreSpy },
        { provide: VectorClockService, useValue: vectorClockSpy },
        { provide: OperationLogCompactionService, useValue: compactionSpy },
        { provide: SnackService, useValue: snackSpy },
        { provide: Store, useValue: storeSpy },
        { provide: ImmediateUploadService, useValue: immediateUploadSpy },
        { provide: ClientIdService, useValue: clientIdSpy },
        { provide: OperationCaptureService, useValue: operationCaptureSpy },
        { provide: SuperSyncStatusService, useValue: superSyncStatusSpy },
      ],
    });

    effects = TestBed.inject(OperationLogEffects);
    lockService = TestBed.inject(LockService);
    clearDeferredActions();
  });

  afterEach(() => clearDeferredActions());

  /**
   * Proof that the deadlock the fix breaks is real: re-requesting `sp_op_log`
   * from within a holder of the same lock must NOT acquire it — pre-fix,
   * processDeferredActions did exactly this and hung for 30s.
   */
  it('rejects nested same-name request on sp_op_log (proves the deadlock exists)', async () => {
    let innerRan = false;
    let caught: unknown = null;

    await lockService.request(LOCK_NAMES.OPERATION_LOG, async () => {
      try {
        // Use a short timeout (200ms) so the assertion is quick. The production
        // path uses LOCK_ACQUISITION_TIMEOUT_MS = 30000ms, which is the 30s
        // delay seen in the user's log.
        await lockService.request(
          LOCK_NAMES.OPERATION_LOG,
          async () => {
            innerRan = true;
          },
          200,
        );
      } catch (e) {
        caught = e;
      }
    });

    expect(innerRan).toBe(false);
    expect(caught).toBeInstanceOf(LockAcquisitionTimeoutError);
  });

  /**
   * With the fix, processDeferredActions({ callerHoldsOperationLogLock: true })
   * skips the inner lock acquisition and runs to completion inside the holder.
   */
  it('processDeferredActions completes inside sp_op_log when caller passes through the flag', async () => {
    bufferDeferredAction(createDeferredAction());

    const order: string[] = [];
    const start = Date.now();

    await lockService.request(LOCK_NAMES.OPERATION_LOG, async () => {
      order.push('outer-start');
      await effects.processDeferredActions({ callerHoldsOperationLogLock: true });
      order.push('outer-end');
    });

    const elapsed = Date.now() - start;

    expect(order).toEqual(['outer-start', 'outer-end']);
    expect(opLogStoreSpy.appendWithVectorClockUpdate).toHaveBeenCalledTimes(1);
    // Should be near-instant — orders of magnitude under the 30s lock timeout.
    expect(elapsed).toBeLessThan(1000);
  });
});
