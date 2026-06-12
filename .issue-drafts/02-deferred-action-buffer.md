# Deferred-action buffer silently drops user actions during sync — fail loudly and harden stuck-window paths

## Issue draft (for GitHub)

### Problem

While remote operations are being applied (`isApplyingRemoteOps`), local persistent actions are not captured as operations. Instead they are buffered in a module-level array and flushed after the apply window closes, so they get fresh vector clocks (`src/app/op-log/capture/operation-capture.meta-reducer.ts`). This design is correct — but the buffer's overflow behavior is not survivable for users:

- The buffer hard-caps at **100** entries (`MAX_DEFERRED_ACTIONS_HARD_LIMIT`, `operation-capture.meta-reducer.ts:145`). Past the cap, the **oldest** buffered action is dropped via `deferredActions.shift()` (`operation-capture.meta-reducer.ts:157-163`).
- Crucially, the inner reducer has **already applied** the dropped action to NgRx state (`operation-capture.meta-reducer.ts:219`) before buffering. A dropped action therefore means: the change is visible on screen right now, but **no operation is ever written**. It never syncs to other devices, and on the next hydration (state is rebuilt from snapshot + op log) it can vanish locally too. This is silent, permanent data divergence/loss.
- In **production the drop is invisible to the user**: the drop path calls `devError()`, which in production builds only does `Log.err` — the snackbar is an unimplemented `TODO` (`src/app/util/dev-error.ts:13-15`). There is no counter, no telemetry, no recovery path. The dropped action even stays in the `deferredActionSet` WeakSet, so the capture effect skips it forever — the code comment itself says it "is silently lost" (`operation-capture.meta-reducer.ts:152-156`).
- There is **no escape hatch if the apply window gets stuck**. The 2s failsafe timer in `HydrationStateService` (`src/app/op-log/apply/hydration-state.service.ts:14`) only covers the `_isSyncWindowOpen` flag, **not** `_isApplyingRemoteOps`. Once stuck, every subsequent user action is buffered, and after 100 of them, every new action silently evicts an older one — indefinitely.

### How a stuck window actually happens (verified paths)

The normal apply window is short (one bulk dispatch + an event-loop yield + sequential archive side effects — `packages/sync-core/src/replay-coordinator.ts:113-150`), and per-second time-tracking ticks (`addTimeSpent`) are *not* persistent actions (only `syncTimeSpent` every ~5 min is), so 100 genuine user actions during a healthy window is implausible. Overflow is in practice a **stuck-flag** symptom, and real stuck paths exist:

1. `OperationLogHydratorService` calls `startApplyingRemoteOps()` / `endApplyingRemoteOps()` around its bulk dispatches **without try/finally** (`src/app/op-log/persistence/operation-log-hydrator.service.ts:261-265` and `:346-350`). If the bulk dispatch throws (a reducer error during replay), capture is disabled for the rest of the session — every later user action is buffered and, past 100, silently dropped one by one.
2. `replayOperationBatch` closes the window in a `finally` (`replay-coordinator.ts:139-150`), which covers throws — but not a **never-settling await** (e.g. archive side effects hung on IndexedDB or a lock). `finally` never runs, the window stays open forever.

Note that even *below* the cap the buffer is in-memory only: a crash/reload mid-sync loses every buffered action's operation (state may or may not survive depending on snapshot timing). The flush path (`OperationLogEffects.processDeferredActions`, `src/app/op-log/capture/operation-log.effects.ts:552-614`) at least retries 3x and shows a sticky `DEFERRED_ACTION_FAILED` snackbar on failure — the overflow path has no equivalent.

### Risk

- Silent loss of user intent (task created/completed/edited during sync simply disappears later) with no error, no log the user can act on, and no way to recover.
- A single replay exception at startup converts the app into a mode where it *looks* fully functional but permanently stops recording operations — the worst possible failure mode for a sync system.

### Proposed direction

Keep the buffer design (it is the right fix for the superseded-vector-clock cascade). Make the failure mode loud and make the stuck states unreachable. Concretely:

1. **Fail loudly on any drop**: a sticky ERROR snackbar (with Reload action, matching the existing `PERSIST_FAILED` / `DEFERRED_ACTION_FAILED` pattern), shown once per sync window, plus `OpLog.err` with action **type** and drop count only (never payloads — log history is exportable).
2. **Raise the cap** from 100 to 1000. Buffered actions are small plain objects; the memory argument for 100 is negligible, and at 1000 overflow only happens in a long-stuck window — by which point the user has already been alerted.
3. **Harden the stuck paths**: wrap the two hydrator dispatch sites in try/finally; add a watchdog that screams (log + devError + snackbar) if `isApplyingRemoteOps` stays continuously true for >60s. The watchdog must **not** force-close the window (see plan).

Rejected alternatives:

- **Blocking user input during remote apply (backpressure)**: user-hostile for a local-first app, the window is normally sub-second, and it would need a global overlay touching far more surface than the bug warrants. The buffer already *is* the backpressure mechanism — it just fails silently at the limit.
- **Persisting dropped actions for later replay**: replaying stale user actions after a reload against changed state risks nondeterministic duplicate operations — a new sync-correctness hazard introduced to recover from a state we can instead make loud and nearly unreachable.

### Acceptance criteria

- [ ] Any deferred-action drop in a production build produces a user-visible sticky error snackbar (at most one per sync window) and an `OpLog.err` containing action type(s) and counts only — no user content.
- [ ] `MAX_DEFERRED_ACTIONS_HARD_LIMIT` raised to 1000; warning threshold behavior unchanged.
- [ ] A throwing bulk dispatch during hydration no longer leaves `isApplyingRemoteOps` stuck true (`operation-log-hydrator.service.ts` both sites).
- [ ] A continuously-true `isApplyingRemoteOps` flag (>60s) is reported loudly; it is never silently permanent.
- [ ] Unit tests cover: drop notification fires once per window and resets on flush; overflow still evicts oldest; hydrator restores capture on dispatch throw; watchdog fires and cancels correctly.
- [ ] No new log line contains task titles, notes, or other user content (CLAUDE.md rule 9).

## Implementation plan

### Phase 1 — Fail loudly on drop + raise cap (S, independently shippable)

Files:

- `src/app/op-log/capture/operation-capture.meta-reducer.ts`
  - Raise `MAX_DEFERRED_ACTIONS_HARD_LIMIT` 100 → 1000.
  - In the overflow branch of `bufferDeferredAction()`, additionally call a notification hook. Simplest surgical wiring: add a `notifyDeferredActionsDropped(droppedActionType: string)` method to `OperationCaptureService` (the module-level `operationCaptureService` reference is already in scope in this file, set via the existing `APP_INITIALIZER` in `src/main.ts:256-265` — no new bootstrap plumbing needed). Guard with `operationCaptureService?.` for the pre-init edge.
  - Track a module-level `hasNotifiedDropThisWindow` flag; reset it in `getDeferredActions()` / `clearDeferredActions()` so the snackbar fires at most once per sync window.
- `src/app/op-log/capture/operation-capture.service.ts`
  - New `notifyDeferredActionsDropped()` method: inject `SnackService`, show sticky ERROR snack with Reload action (mirror `notifyUserAndTriggerRollback()` in `operation-log.effects.ts:378-390`), `OpLog.err` with action type + running drop count.
  - **Must defer the snack out of the reducer call stack** with `setTimeout(..., 0)`: `bufferDeferredAction` runs synchronously inside a reducer pass; opening a Material snackbar (which can trigger change detection / further dispatches) inside a reducer is unsafe.
- `src/assets/i18n/en.json` + `src/app/t.const.ts`: new key, e.g. `T.F.SYNC.S.DEFERRED_ACTIONS_DROPPED` ("Sync took too long and some recent changes could not be recorded. Please reload to avoid losing data."), next to the existing `DEFERRED_ACTION_FAILED` (`en.json:1524`). Edit only `en.json` per repo rules.

Tests: extend `src/app/op-log/capture/operation-capture.meta-reducer.spec.ts` — overflow evicts oldest and calls notify exactly once per window; flag resets after `getDeferredActions()`; no notify below cap. New spec coverage in `operation-capture.service.spec.ts` for the deferred snack (use fakeAsync/tick).

Sync-correctness risks: none to capture semantics — drop behavior (evict oldest) is unchanged, only observability is added. Raising the cap means a larger post-sync flush; `processDeferredActions` already writes sequentially with retries and preserves order, so no change needed there. The deferred `setTimeout` keeps the reducer pass pure (no dispatch/UI work inside a reducer — invariant from `contributor-sync-model.md`).

Run `npm run checkFile` on every touched `.ts` file.

### Phase 2 — Harden stuck-window paths (S, independently shippable)

Files:

- `src/app/op-log/persistence/operation-log-hydrator.service.ts:261-265` and `:346-350`: wrap each `startApplyingRemoteOps()` … `dispatch(bulkApplyOperations(...))` … `endApplyingRemoteOps()` in try/finally so a throwing reducer during replay cannot permanently disable operation capture. (Reference pattern: `ValidateStateService` already does this correctly at `validate-state.service.ts:168-190`.)
- `src/app/op-log/apply/hydration-state.service.ts`: add a watchdog timer started in `startApplyingRemoteOps()` and cleared in `endApplyingRemoteOps()` (~60s). On fire: `OpLog.err` + `devError` + (via lazy-injected `SnackService`) a sticky error snack suggesting reload.
  - **The watchdog must NOT call `endApplyingRemoteOps()` or flush the buffer.** Force-closing while ops are genuinely still applying would let local actions capture with superseded vector clocks — exactly the cascade this window exists to prevent (`operation-capture.meta-reducer.ts:59-74`). Report loudly; let the user reload. Call this out in a code comment.
  - Repeated `startApplyingRemoteOps()` calls must restart the timer (same restartable pattern as `openSyncWindow()`'s failsafe at `hydration-state.service.ts:177-190`).

Tests: extend `src/app/op-log/apply/hydration-state.service.spec.ts` (watchdog fires after threshold, is cancelled by `endApplyingRemoteOps`, restarts on re-entry — fakeAsync). Hydrator spec: bulk dispatch throws → `isApplyingRemoteOps` is false afterwards and the error still propagates.

Sync-correctness risks: ending the window in `finally` after a failed hydration dispatch means subsequent local actions capture against possibly partially-hydrated state — but that is strictly better than the status quo (capture disabled forever, every action eventually dropped), and the hydrator already surfaces hydration failures separately. The watchdog deliberately changes no sync state. Mention both in the PR description.

### Phase 3 (optional) — Drop diagnostics for support (S)

- `operation-capture.meta-reducer.ts`: keep a cumulative in-memory record of dropped action **types and timestamps** (never payloads), exposed via e.g. `getDeferredActionDropStats()`; reset on flush.
- Surface the counter in the existing sync debug/log export path so bug reports can show "N actions dropped, types: […]".

Tests: meta-reducer spec additions. Sync risk: none (read-only diagnostics). Rule 9 applies: types/counts/timestamps only.

## Verification notes

- **Confirmed**: buffering during `isApplyingRemoteOps` with soft warning threshold 10 and hard cap 100 — `operation-capture.meta-reducer.ts:139` (`MAX_DEFERRED_ACTIONS_WARNING = 10`, fires at >10, i.e. the 11th item), `:145` (`MAX_DEFERRED_ACTIONS_HARD_LIMIT = 100`).
- **Confirmed (lines corrected slightly)**: oldest-action drop is at `operation-capture.meta-reducer.ts:157-163` (seed said ~157-162; `shift()` is line 162, the brace closes at 163). The dropped action remains in the `deferredActionSet` WeakSet (line 91) so the capture effect skips it permanently; the in-code comment (lines 152-156) explicitly says it "is silently lost."
- **Confirmed with nuance ("silently")**: the drop path calls `devError()`, which in production is `Log.err` only — the user-facing snack is an unimplemented `TODO` (`src/app/util/dev-error.ts:12-15`). So drops are logged to the internal log but invisible to users in production; in dev builds an alert/confirm fires. No counter or telemetry exists.
- **Confirmed**: no timeout/escape hatch for the apply flag. `SYNC_WINDOW_FAILSAFE_MS = 2000` (`hydration-state.service.ts:14,177-190`) guards only `_isSyncWindowOpen`; `_isApplyingRemoteOps` has no failsafe. Found two concrete stuck paths: hydrator start/end pairs not in try/finally (`operation-log-hydrator.service.ts:261-265`, `:346-350`), and never-settling awaits escaping `replayOperationBatch`'s `finally` (`packages/sync-core/src/replay-coordinator.ts:139-150`).
- **Flush path located**: `OperationLogEffects.processDeferredActions()` (`operation-log.effects.ts:552-614`, 3 retries + sticky `DEFERRED_ACTION_FAILED` snack, key exists at `en.json:1524`); driven by `replayOperationBatch`'s `finally` via `OperationApplierService` (`operation-applier.service.ts:114-119`) and explicitly post-`mergeRemoteOpClocks` from `remote-ops-processing.service.ts:474` and `conflict-resolution.service.ts:484` (#7700, `process-deferred-actions-flush.util.ts`).
- **Window length / fill rate**: normal window = one bulk dispatch + yield + sequential per-op archive side effects — sub-second to a few seconds for large archive batches. Per-second tracking ticks (`addTimeSpent`) are not persistent actions (only `syncTimeSpent` every ~5 min is — `time-tracking.actions.ts:66-82`), so reaching 100 buffered actions essentially requires a stuck window, not a slow one. This reframes the fix: loud failure + stuck-path hardening matters more than the cap value itself.
- **Confirmed**: UI input is not blocked during sync — only a spinning sync icon in the header (`main-header.component.html:63`).
- **Dropped (no evidence available)**: rationale for the value 100. The file's entire history is a single squashed commit (`fa922d5`, mislabeled "feat(jira): show issue priority"), so the constant arrived with the initial op-log import with only its current comment ("prevent unbounded memory growth") — no recorded justification.
- **Added finding**: the dropped action's state change is already applied by the inner reducer before buffering (`operation-capture.meta-reducer.ts:217-233`), so a drop = on-screen change with no operation behind it → silent cross-device divergence and likely local loss on next hydration. This makes the bug data loss, not just a missed sync.
