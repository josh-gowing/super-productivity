# Decouple the tasks ↔ work-context ↔ project/tag core by chipping away at TaskService and adding a feature-boundary lint rule

## Issue draft (for GitHub)

### Problem

The `tasks`, `work-context`, `project`, and `tag` features form a tightly coupled core
with bidirectional dependencies, and `TaskService` has grown into a god object that
mixes ~6 distinct responsibilities. This makes most state-related changes risky (every
edit lands in a file imported by 78 non-spec files outside `features/tasks`), makes the
sync-correctness rules harder to uphold (more surface per file = more chances to violate
the one-intent-one-op invariant), and slows down anyone trying to work on a single
concern like archiving or scheduling.

Important framing: **tasks being a hub is partly inherent to the domain.** Projects, tags,
planner, schedule, and issue providers all legitimately operate *on tasks*. The goal is
NOT to break the hub, and explicitly NOT a big-bang restructuring of the dependency
triangle. The goal is to separate *acceptable* hub-ness (siblings importing `task.model`
and task selectors — read-only, type-level coupling) from *accidental* coupling
(siblings reaching into `TaskService` internals, `tasks` importing sibling UI components,
and `TaskService` owning orchestration that belongs to other features).

### Evidence (verified 2026-06-12 against current `master`)

**God objects (LOC / injected services via `inject()`):**

| File | LOC | injects |
| --- | --- | --- |
| `src/app/features/tasks/task.service.ts` | 1,395 | — (CRUD, hierarchy, drag-drop ordering, archive, scheduling/reminders, issue linkage, ~45 selector usages, Observable + `toSignal` twins) |
| `src/app/features/tasks/task/task.component.ts` | 1,362 | 20 (lines 153–173) — declared hot path, rendered once per task |
| `src/app/features/work-context/work-context.service.ts` | 817 | imports `TagService`, project selectors/actions/models, task models, `TaskArchiveService` |
| `src/app/plugins/plugin-bridge.service.ts` | 2,093 | 23 |
| `src/app/core/startup/startup.service.ts` | 469 | 20 |

**Bidirectional coupling (import-statement counts, occurrences across `.ts` files):**

- `features/tasks` → siblings: project **62**, work-context **57**, tag **45**, issue **28**, planner **22**.
- Reverse direction (files importing from `features/tasks`): issue **38**, schedule **30**, planner **25**, work-context **12**, tag **7**, project **6**.
- What the reverse imports actually pull in (occurrences): `task.model` **88**, `task.service` **33**, `task.selectors` **19**, the rest single digits. I.e. ~60% of the inbound coupling is type-level (acceptable); the **33 `TaskService` imports** and the cross-feature *component* imports are the accidental part. Examples of the latter inside `tasks`: `planner/dialog-schedule-task/dialog-schedule-task.component` imported 6×, `tag/tag/tag.component` 3×, `issue/issue-icon/issue-icon.pipe` 5×.

**TaskService responsibility slices (by line range, current file):**

- Drag-drop/keyboard ordering: `move` / `moveUp` / `moveDown` / `moveToTop` / `moveToBottom` — lines 523–763 (~240 LOC), coupled to `WorkContextService` and `work-context/store/work-context-meta.helper` (`getAnchorFromDragDrop`).
- Archive orchestration: `moveToArchive` (888–954), `restoreTask` (992), `updateEverywhere` (1177), `updateArchiveTask(s)` (1189–1196), `getByIdFromEverywhere` (1198), `getArchivedTasks` / `getArchiveTasksForRepeatCfgId` / `getAllTasksEverywhere` (1224–1266) — ~230 LOC, coupled to `ArchiveService` + `TaskArchiveService`.
- Scheduling: `addAndSchedule` (431), `scheduleTask` (1039), `reScheduleTask` (1055) — thin dispatch wrappers around `TaskSharedActions.scheduleTaskWithTime` / `reScheduleTaskWithTime`.
- Issue linkage: `getAllIssueIdsForProject` (1241, **0 external call sites** — likely dead), `getAllIssueIdsForProviderEverywhere` (1251), `checkForTaskWithIssueEverywhere` (1268), `markIssueUpdatesAsRead` (1119).

**Blast radius of those slices is small** (external non-spec call sites): `moveToArchive` 3, `moveUp`/`moveDown`/`moveToBottom` 1 each, `moveToTop` 2, `scheduleTask` 7, `reScheduleTask` 1, `checkForTaskWithIssueEverywhere` 5, `updateArchiveTask` 4, `getByIdFromEverywhere` 3, `getAllIssueIdsForProviderEverywhere` 2.

**Work-context abstraction leaks:**

- `WorkContextType` is referenced in **55 files outside** `features/work-context` (284 occurrences); **53** non-spec `=== WorkContextType.PROJECT|TAG` comparisons live outside the feature (e.g. `task.service.ts:966`, `note.service.ts:48`, `issue.service.ts:540`), each one a branch on "is this a project or a tag?" that the abstraction was supposed to hide.
- Backlog exists only for projects: `WorkContextCopy` carries optional `isEnableBacklog?` / `backlogTaskIds?` (`work-context.model.ts:79-80`) while `Project` has them for real (`project.model.ts:22,24`) and `Tag` not at all — consumers must know which concrete type they hold.

**Precedent already in the repo:**

- Boundary enforcement via `no-restricted-imports` already exists for `packages/sync-core` and `packages/sync-providers` (`eslint.config.js:125-210`), plus a local-rules plugin (`eslint-local-rules/rules/`) with sync-correctness rules. The same mechanism can guard `src/app/features/*` boundaries.
- `TaskFocusService` (`src/app/features/tasks/task-focus.service.ts`) is an existing successful extraction from TaskService — the pattern works.

### Risk

- Every extracted method dispatches actions that flow through the op-log; changing dispatch *ordering or payload shape* during a move can corrupt sync (see `docs/sync-and-op-log/contributor-sync-model.md`). Extractions must be move-only.
- `task.component.ts` is a hot path (per-task render); any change there needs verification against a large task list.
- 78 files consume `TaskService`; a delegating-facade transition period keeps each PR small.

### Proposed direction

Chip away, never big-bang. Each step is an independent PR that moves code without
changing dispatched actions, and the lint rule prevents regression.

1. **Boundary lint rule first** (`eslint.config.js`, modeled on the existing `packages/` rules): for `src/app/features/{project,tag,work-context}/**`, restrict imports from `features/tasks/**` to `task.model` / `task.selectors` / explicitly baselined exceptions; for `src/app/features/tasks/**`, forbid importing sibling *components/pipes* (models/consts stay allowed). Start at `warn` with the current offenders baselined; ratchet to `error` per-folder as they're cleaned up.
2. **Extract 3–4 orchestration slices from TaskService** (lowest blast radius first): `TaskArchiveOrchestrator`, `TaskOrderingService` (drag-drop/move methods), `TaskSchedulingFacade`, task↔issue lookup. TaskService keeps thin delegating methods initially so the 78 consumers don't churn; callers migrate opportunistically.
3. **Task.component injection diet**: target ≤16 injects (from 20) by moving dialog/snack/translate plumbing for context actions into the already-extracted services; verified against a large list.
4. **Shrink the `WorkContextType` leak** by adding capability-style accessors on `WorkContextService` (e.g. `isBacklogAvailable`, "tag to strip on archive") so consumers stop branching on the enum — *only* where call sites already exist; no polymorphic redesign.

### Acceptance criteria

- [ ] Feature-boundary `no-restricted-imports` rule active for the four core features with a recorded baseline; CI fails on **new** violations.
- [ ] `task.service.ts` < 900 LOC with archive, ordering, scheduling, and issue-lookup slices in dedicated injectables, each with unit tests; no change to dispatched action types/payloads (assert in tests).
- [ ] `task.component.ts` ≤ 16 injected services, with no measurable render/CD regression on a large task list.
- [ ] `=== WorkContextType.*` comparisons outside `features/work-context` reduced (53 → ≤ 40) via capability accessors; no new ones (lint or review checklist).
- [ ] Dead code confirmed/removed: `TaskService.getAllIssueIdsForProject` (0 call sites).
- [ ] Explicitly NOT done (out of scope, see below): plugin-bridge split, StartupService rework, backlog-for-tags, breaking sibling imports of `task.model`.

### Out of scope

- `plugin-bridge.service.ts` (2,093 LOC / 23 injects) — separate issue; it's an API surface, not part of this triangle.
- `StartupService` (20 deps, `DEFERRED_INIT_DELAY_MS = 1000` deferred-init at `startup.service.ts:51,137`) — separate issue. Note: the prior review's "no timeout guard on `hydrateStore()`" actually concerns `OperationLogHydratorService` (`src/app/op-log/persistence/operation-log-hydrator.service.ts:68`), i.e. the op-log layer, not this refactor.
- Making backlog available for tags, or any `WorkContext` polymorphic redesign.
- Removing sibling imports of `task.model` / task selectors — that is the acceptable, inherent hub.
- Any change to op-log capture, meta-reducers, or action shapes.

## Implementation plan

Each phase is independently shippable and reviewable in isolation. All phases:
run `npm run checkFile` on touched files; commit as `refactor(tasks): …` (lint phase: `build(lint): …`).

### Phase 0 — Feature-boundary lint rule + baseline (S)

- **Files:** `eslint.config.js` (new config blocks next to the existing `packages/sync-core` block at lines 125–168); possibly a small custom rule in `eslint-local-rules/rules/` if `no-restricted-imports` patterns can't express "allow `task.model`, forbid the rest" cleanly (it can, via `group` + negated patterns — try that first).
- **Rules:**
  - `src/app/features/{project,tag,work-context}/**`: deny `*/tasks/**` except `*/tasks/task.model`, `*/tasks/store/task.selectors`; baseline current offenders (project 6 files, tag 7, work-context 12) via per-file `/* eslint-disable-next-line */` with a tracking comment, or scope the rule with `ignores` until cleaned.
  - `src/app/features/tasks/**`: deny sibling `**/*.component`, `**/*.pipe` imports (currently: `dialog-schedule-task.component` ×6, `tag.component` ×3, `issue-icon.pipe` ×5, `tag-list.component` ×2 …) — baseline these the same way.
- **Tests:** rule spec in `eslint-local-rules/rules/*.spec.js` only if a custom rule is needed; otherwise `npm run lint` green is the test.
- **Risk:** none at runtime. Pure tooling.

### Phase 1 — Extract `TaskArchiveOrchestrator` (M)

- **New file:** `src/app/features/tasks/task-archive-orchestrator.service.ts` (+ `.spec.ts`). Move from `task.service.ts`: `moveToArchive` (888–954), `restoreTask`, `updateEverywhere`, `updateArchiveTask`, `updateArchiveTasks`, `getByIdFromEverywhere`, `getAllTasksForProject`, `getArchiveTasksForRepeatCfgId`, `getArchivedTasks`, `getAllTasksEverywhere` (~230 LOC). TaskService keeps one-line delegates for now.
- **External call sites** (migrate in same PR, it's small): `moveToArchive` 3, `updateArchiveTask` 4, `getByIdFromEverywhere` 3, rest ≤2.
- **Sync-correctness risks (call out in PR):** `moveToArchive` dispatches `TaskSharedActions.moveToArchive` *then* awaits `ArchiveService.moveTasksToArchiveAndFlushArchiveIfDue` — **preserve this exact ordering**; the action is meta-reduced (rule 3) and the archive flush is the persistence side. The sub-task branch loops `updateTags` dispatches — do NOT "optimize" into a different action shape, and if it ever becomes a bulk loop, rule 6 (`setTimeout(0)` after loop) applies. No effects are added or removed, so rules 1–2 are untouched.
- **Tests:** unit spec asserting the dispatched action sequence (type + payload) is byte-identical to before the move; reuse existing `task.service.spec.ts` cases by pointing them at the orchestrator.

### Phase 2 — Extract `TaskOrderingService` (M)

- **New file:** `src/app/features/tasks/task-ordering.service.ts` (+ spec). Move `move`, `moveUp`, `moveDown`, `moveToTop`, `moveToBottom` (lines 523–763, ~240 LOC). This removes `getAnchorFromDragDrop` / `work-context-meta.actions` / part of the `WorkContextService` surface from TaskService.
- **External call sites:** 6 total (mostly `task.component.ts` keyboard shortcuts and the drag-drop list); migrate directly, keep TaskService delegates one release if preferred.
- **Hot-path risk:** `task.component.ts` swaps one injected service for another (net injection count unchanged this phase); no template changes, no new per-instance subscriptions — still re-verify with a large list per CLAUDE.md.
- **Sync risk:** dispatch-only moves (`moveTaskInTodayList`, `moveProjectTaskInBacklogList`, `moveSubTask`, …); payloads must be identical. These actions are op-logged ordering ops — assert action equality in the spec.

### Phase 3 — `TaskSchedulingFacade` + issue-lookup extraction, delete dead code (S)

- **Files:** `src/app/features/tasks/task-scheduling.facade.ts` (move `scheduleTask`, `reScheduleTask`, and the schedule half of `addAndSchedule`; pulls `remind-option-to-milliseconds` util with it) and `src/app/features/tasks/task-issue-lookup.service.ts` (move `getAllIssueIdsForProviderEverywhere`, `checkForTaskWithIssueEverywhere`, `markIssueUpdatesAsRead`). Delete `getAllIssueIdsForProject` (0 call sites — re-verify with grep at PR time).
- **Call sites:** `scheduleTask` 7, `checkForTaskWithIssueEverywhere` 5, others ≤2 — migrate in-PR.
- **Sync risk:** `scheduleTask`/`reScheduleTask` are thin `TaskSharedActions` dispatch wrappers; identical-payload assertion in spec. The issue-lookup service is read-only (archive reads + selectors) — no op-log interaction.
- **Outcome check:** after Phases 1–3, `task.service.ts` should be ~850–900 LOC. If >900, the LOC criterion moves to the next extraction (e.g. time-spent block at 826–858/996), not to creative deletion.

### Phase 4 — task.component injection diet (M)

- **Files:** `src/app/features/tasks/task/task.component.ts` (+ template only if bindings move), the Phase 1–3 services.
- **Approach:** the component currently injects `SnackService`, `TranslateService`, `LocaleDatePipe`, `MatDialog`, `DateAdapter`, `PlannerService` largely for context-menu/dialog flows. Fold the schedule-dialog and snack-feedback plumbing into `TaskSchedulingFacade`/existing dialog components so the component drops to ≤16 injects. Do NOT introduce template function calls or per-instance observables in the process; computed signals only.
- **Hot-path risk (primary):** this is the per-task component — the header comment already warns about 600+ subscriptions. Verify: render a 500+ task list before/after (e.g. via the existing perf tooling `tools/gen-perf-metrics.js` or manual DevTools profile), confirm no added change-detection work.
- **Tests:** existing component spec + one E2E smoke (`npm run e2e:file` on a task-list spec).

### Phase 5 — Work-context capability accessors (M, optional/follow-up)

- **Files:** `src/app/features/work-context/work-context.service.ts` (+ model), then mechanical call-site swaps in `tasks`, `note`, `issue`.
- **Approach:** add semantic accessors for the *recurring* enum checks only — e.g. "does the active context have a backlog?" (today answered by `WorkContextType.PROJECT && isEnableBacklog`), "tag id to strip instead of archiving" (the `moveToArchive` TAG branch). Swap the ~15 highest-traffic of the 53 comparisons; leave one-off checks alone.
- **Sync risk:** accessors are pure reads over already-selected state; no new selector-based effects (rule 2 not triggered). Any reducer/selector touched must keep taking `startOfNextDayDiffMs` as an arg where applicable (rule 4) — though this phase shouldn't touch reducers at all; if it starts to, stop and re-scope.

### Explicitly not planned

Plugin-bridge split, StartupService/hydration timeout work (belongs to op-log), backlog for tags, removing `task.model` hub imports, any meta-reducer or action-shape change.

## Verification notes

Claims checked against the working tree on 2026-06-12 (grep/wc, non-spec where noted):

**Confirmed exactly:**

- LOC: `task.service.ts` 1,395; `task.component.ts` 1,362; `plugin-bridge.service.ts` 2,093; bonus: `work-context.service.ts` 817, `startup.service.ts` 469.
- tasks→sibling import-statement counts: project 62, work-context 57, tag 45, issue 28, planner 22 — match the seed to the digit.
- Reverse "25–42 files" claim: planner 25, schedule 30, issue 38 files import from `features/tasks` — within the stated range. Also measured: work-context 12, tag 7, project 6 files.
- project/tag import tasks: confirmed (6 and 7 files respectively).
- eslint boundary precedent exists: `eslint.config.js:125-210` (`no-restricted-imports` for `packages/sync-core`, `packages/sync-providers`) plus `eslint-local-rules/rules/` custom-rule infra.
- Backlog only for projects: `WorkContextCopy.isEnableBacklog?/backlogTaskIds?` optional (`work-context.model.ts:79-80`); concrete on `Project` (`project.model.ts:22,24`); absent on `Tag`.
- TaskService mixes Observables + `toSignal` twins (5 `toSignal` calls, e.g. `currentTaskId$`/`currentTaskId` at lines 131–166) and ~45 selector usages ("20+ selectors" — understated, holds).
- `StartupService` ~20 deps: exactly 20 `inject()` calls; deferred init via `window.setTimeout(…, DEFERRED_INIT_DELAY_MS /* = 1000 */)` at `startup.service.ts:51,137` — it's a named constant, not an inline magic number.

**Corrected:**

- `task.component.ts` injects **20** services (lines 153–173), not ~17.
- `plugin-bridge.service.ts` injects **23** services, not ~25.
- `WorkContextService` does **not** import `ProjectService`; it imports `TagService`, project *selectors/actions/models/consts* (`selectProjectById`, `updateProjectAdvancedCfg`, `Project`, `INBOX_PROJECT`), task models, and `TaskArchiveService`. The leak is real, the named dependency was wrong.
- "No timeout guard on `hydrateStore()`": `hydrateStore()` lives in `OperationLogHydratorService` (`src/app/op-log/persistence/operation-log-hydrator.service.ts:68`), not `StartupService`. `StartupService._initPlugins` does await `isAllDataLoadedInitially$` + sync-done with no timeout (`startup.service.ts:457-462`), so the *spirit* holds, but it's op-log-layer scope — moved to out-of-scope rather than asserted here.

**Newly gathered (strengthens the seed):**

- Inbound coupling decomposes into `task.model` ×88, `task.service` ×33, `task.selectors` ×19 occurrences — quantifies acceptable vs. accidental hub-ness.
- `WorkContextType` used in 55 files / 284 occurrences outside the feature; 53 non-spec `=== WorkContextType.*` comparisons outside it.
- Extraction blast radii are genuinely small (external non-spec call sites: `moveToArchive` 3, `moveUp/Down/ToBottom` 1, `moveToTop` 2, `scheduleTask` 7, `reScheduleTask` 1, `checkForTaskWithIssueEverywhere` 5, `updateArchiveTask` 4, `getByIdFromEverywhere` 3, `getAllIssueIdsForProviderEverywhere` 2).
- `TaskService.getAllIssueIdsForProject` has **0** external call sites — dead-code candidate.
- `TaskService` is imported by 78 non-spec files outside `features/tasks` — justifies the delegating-facade transition.
- `TaskFocusService` exists as in-repo precedent for exactly this kind of extraction.

**Dropped:** none — every seed claim either held or was correctable with evidence.
