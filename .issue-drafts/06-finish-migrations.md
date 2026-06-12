# Finish the stacked half-done migrations (tracking issue)

## Issue draft (for GitHub)

### Why

The codebase has accumulated several architectural migrations that are 80–100% done but never formally closed out. Each unfinished migration doubles the patterns a contributor must recognize ("is this the old way or the new way?"). This umbrella issue records the **measured current state** of each one, defines done-criteria so progress is checkable with a grep, and explicitly marks the items that are *not* worth finishing so nobody burns time on them.

Each metric below includes the command used to produce it, so re-running it shows progress.

---

### 1. PFAPI → op-log: delete the dead remnants, keep the migration path

**Current state (measured 2026-06):**

- `src/app/pfapi/` contains exactly **4 compiled `.js` files** (`pfapi-config.js`, `api/pfapi.js`, `api/index.js`, `api/model-ctrl/meta-model-ctrl.js`), all headed `@deprecated LEGACY CODE`.
- **Nothing imports them.** `grep -rn "app/pfapi\|\.\./pfapi" src --include="*.ts"` → 0 import sites; no references in `angular.json`, `package.json`, or any tsconfig. `api/index.js` even `require`s files that no longer exist (`./pfapi.model`, `./pfapi.const`), so it could not load if something tried. This is pure dead code.
- The **live** legacy-compat path does *not* go through `src/app/pfapi/`. It is:
  - `src/app/core/persistence/legacy-pf-db.service.ts` (410 LOC, direct IndexedDB access to the old `pf` database) — 8 non-spec consumers, all legitimately legacy-facing (`operation-log-migration.service.ts`, `operation-log-recovery.service.ts`, `archive-migration.service.ts`, `client-id.service.ts`, `startup.service.ts`, `reminder.service.ts`, `sync-wrapper.service.ts`).
  - `SyncWrapperService._syncVectorClockToPfapi()` (`src/app/imex/sync/sync-wrapper.service.ts:1523`) — bridges the SUP_OPS vector clock into the legacy `pf.META_MODEL` before every non-SuperSync sync, so v16.x clients sharing a Dropbox/WebDAV/LocalFile remote stay coherent.
  - `LegacySyncFormatDetectedError` handling (`sync-wrapper.service.ts:~766`, `file-based-sync-adapter.service.ts:909`) for remotes that still contain v16.x `__meta_` files (issues #5964, #6174).
- `sync-wrapper.service.ts` (1,542 LOC) is **not legacy glue** — it is the active orchestration/UI layer (conflict dialogs, error snackbars, force-upload flows) over `src/app/op-log/`. Its imports are almost entirely from op-log. Do not delete; at most split for size later.
- Migration is covered by tests: `src/app/op-log/testing/integration/legacy-data-migration.integration.spec.ts`, `credential-store.legacy-migration.spec.ts`, and others.

**Target:** zero dead pfapi code in tree; the *live* legacy-compat surface (`LegacyPfDbService` + vector-clock bridge + `__meta_` detection) stays until a documented sunset version.

**Done criteria:**

- [ ] `src/app/pfapi/` deleted (4 files, zero importers — one commit).
- [ ] Stale `Pfapi*` naming cleaned up where it misleads: `export { StateSnapshotService as PfapiStoreDelegateService }` in `src/app/op-log/backup/state-snapshot.service.ts:294`; comments referencing a no-longer-existing `PfapiService` in `client-id.provider.ts`, `archive-operation-handler.service.ts`, `work-context.service.ts:593`, `project.effects.ts:78-93` (commented-out code).
- [ ] A short "legacy sunset" note added to `docs/sync-and-op-log/` stating which app version may remove `LegacyPfDbService`, the vector-clock bridge, and `__meta_` detection (app is privacy-first with no telemetry, so this must be a version-age judgement call by the maintainer — e.g. "two majors after v18").
- [ ] `LegacyPfDbService` and the bridge are **NOT** removed in this issue.

**Priority / effort:** **High priority, small effort** (the deletion + rename part). The sunset itself is deliberately deferred — removing the migration path too early silently strands v16 users' data.

---

### 2. Standalone components / NgModule removal — 95% done, finish the last 5

**Current state (measured 2026-06):**

- **247** component files, **0** `standalone: false` (`grep -rn "standalone: false" src --include="*.ts"` → empty), **0** components in any `declarations: []`. With Angular 21 defaulting to standalone, the component migration is effectively **100% complete** — the old "~32% adoption (46/143)" figure is obsolete; it was counting `standalone: true` flags, which new Angular no longer requires.
- **5 NgModules remain** (`grep -rn "@NgModule" src --include="*.ts"`):
  1. `src/app/ui/mentions/mention.module.ts` — pure re-export of 2 standalone declarables; 2 consumers (`task-title.component.ts`, `add-task-bar.component.ts`).
  2. `src/app/ui/validation/validation.module.ts` — pure re-export of 2 standalone directives; 1 consumer (`formly-config.module.ts`).
  3. `src/app/features/reminder/reminder.module.ts` — **not really a module**: an empty-declarations NgModule whose ~470-line constructor runs reminder/notification orchestration as a side effect (violates the repo's own "no side effects in constructors" anti-pattern). Imported in `main.ts` purely to execute.
  4. `src/app/ui/formly-config.module.ts` — root-only `FormlyModule.forRoot(...)` aggregation, documented as such; imported once via `importProvidersFrom` in `main.ts`.
  5. `src/app/root-store/feature-stores.module.ts` — NgRx `StoreModule.forFeature`/`EffectsModule.forFeature` aggregation.
- Cosmetic residue: **121** now-redundant `standalone: true` flags.

**Target:** 0 NgModules that hide logic or exist only to re-export; root-config aggregation modules may stay if converting buys nothing.

**Done criteria:**

- [ ] `reminder.module.ts` logic moved into a proper initializer (e.g. `ReminderInitService.init()` wired via `provideAppInitializer` or the existing startup service) — this is the only one with a real defect, not just style.
- [ ] `mention.module.ts` and `validation.module.ts` deleted; the 3 consumers import the standalone directives/components directly.
- [ ] `formly-config.module.ts` / `feature-stores.module.ts`: explicitly **accepted as-is** (convert to `provideX()` functions only if someone is in there anyway — zero contributor-confusion cost, both are documented root-only aggregators).
- [ ] Optional cleanup: drop redundant `standalone: true` flags (`ng generate @angular/core:standalone` or a sed pass) — pure noise reduction, fine to skip.

**Priority / effort:** **Medium priority, small effort.** Finishing it lets the project say "there are no NgModules with behavior" — a real onboarding simplification for ~1–2 days of work.

---

### 3. Observables → Signals — the real long tail; needs a policy, not a project

**Current state (measured 2026-06):**

- **145** public `foo$` Observable members across `*.service.ts` (non-spec), vs **63** `toSignal(...)` members in services; **64** non-spec files use `toSignal`.
- The twin pattern is real: e.g. `task.service.ts` (1,395 LOC) exposes `currentTaskId$` *and* `currentTaskId = toSignal(this.currentTaskId$)` (lines 131–158); `work-context.service.ts` has **38** public `$` observables and 1 signal twin; 17+ services mix both.
- **37** templates still use `| async`.
- **11** services still hold `BehaviorSubject` state.
- CLAUDE.md already mandates "Prefer Signals to Observables", so the *direction* is settled; what's missing is closing the seam.

**Target (Signals-first, pragmatic):** signals are the default read API for state; observables remain legitimate for genuinely event/stream-shaped things (effects, debounced pipelines, interop). A 145-member big-bang conversion is **not** the target.

**Done criteria (policy + ratchet, checkable):**

- [ ] Written rule in CLAUDE.md or a short doc: new service state → `signal()`/`computed()`/store `selectSignal`; expose `toObservable(...)` at the boundary only where a consumer needs a stream — i.e. **the twin pattern inverts** (signal is the source, observable is derived), and no *new* `X$`-as-source twins are added.
- [ ] When a component is touched, its `| async` usages in that component are converted (ratchet: the 37-template count only goes down).
- [ ] One flagship conversion to serve as the reference PR (suggested: `task.service.ts` twins, since it's the most-imitated service — but note the task component hot-path warning in CLAUDE.md and benchmark against a large task list).
- [ ] Re-measure quarterly with: `grep -rhE "^  [a-zA-Z_0-9]+\$(:| =)" src/app --include="*.service.ts" | wc -l` (currently 145) and `grep -rl "| async" src/app --include="*.html" | wc -l` (currently 37).

**Priority / effort:** **Medium priority, large total effort, but amortized.** Do NOT schedule this as a standalone work item beyond the policy + flagship PR; bulk conversion churns sync-sensitive code (selector-based effects need `skipDuringSyncWindow()`) for little user value.

---

### 4. Platform detection (`IS_ANDROID_WEB_VIEW` vs `CapacitorPlatformService`)

**Current state (measured 2026-06):** `IS_ANDROID_WEB_VIEW` (module-scope constant in `src/app/util/is-android-web-view.ts`, with an `IS_ANDROID_WEB_VIEW_TOKEN` testing shim) appears in **36** non-spec files (44 incl. specs) — the previously claimed ~63 is outdated; it has already shrunk. `src/app/core/platform/capacitor-platform.service.ts` + `platform-capabilities.model.ts` are the newer layer.

**Tracked separately** in the platform-abstraction issue (draft `03-platform-abstraction`). Listed here only so this umbrella is complete; do not duplicate work — check that issue's checklist instead.

**Priority / effort:** see issue 03.

---

### 5. Build tooling (three tsc paths + preload bundler) — fine as-is, close as "won't fix"

**Current state (measured 2026-06):**

- Three compilation paths exist: Angular CLI (frontend), `tsc -p electron/tsconfig.electron.json` (Electron main), and per-package tsconfigs under `packages/` (driven by `packages/build-packages.js`). Plus `e2e/tsconfig.json` and worker/spec tsconfigs — normal for this shape of project.
- `electron/scripts/bundle-preload.js` is **not** a hand-rolled bundler: it is a **15-line esbuild invocation** (entry `electron/preload.ts` → CJS `preload.js`, `external: ['electron']`). Nothing to consolidate; replacing it with config-file ceremony would be a lateral move.
- The pieces compose in one script: `"electron:build": "node ./tools/build-wayland-idle-helper.js && tsc -p electron/tsconfig.electron.json && node electron/scripts/bundle-preload.js"`.

**Verdict:** **No action. Low priority bordering on "don't".** Each toolchain matches its runtime (browser bundle / Node main process / publishable packages). Consolidating onto a single bundler would be a multi-day change with real release-pipeline risk (asar layout, `verify-electron-requires.js`) and zero contributor-facing simplification. Re-open only if Electron-main needs bundling for startup-perf or ESM reasons.

---

### Summary checklist

- [ ] **(1) Delete `src/app/pfapi/` + stale `Pfapi*` naming; document legacy sunset version** — high value, small
- [ ] **(2) Retire `reminder.module.ts` logic-module + 2 re-export modules** — medium value, small
- [ ] **(3) Signals-first policy + flagship `task.service.ts` PR + ratchet metrics** — medium value, amortized
- [ ] **(4) Platform detection** — deferred to issue 03
- [x] **(5) Build tooling** — reviewed, intentionally left as-is

## Implementation plan

### Item 1: PFAPI dead-code deletion + sunset doc (highest value; ~half a day)

**Phase 1 — delete (one commit, `refactor(sync): remove dead compiled pfapi shims`):**
- `git rm -r src/app/pfapi/` (4 files). Pre-verified: zero import sites in `src/`, `electron/`, `angular.json`, tsconfigs; `api/index.js` requires files that don't exist, so it was unloadable anyway.
- Build + full unit suite (`npm test`) as a tripwire; run `npm run e2e:file e2e/...legacy...` if a legacy-migration E2E exists, plus the integration specs: `npm run test:file src/app/op-log/testing/integration/legacy-data-migration.integration.spec.ts`.

**Phase 2 — de-confuse naming (one commit, `refactor(sync): remove stale Pfapi naming`):**
- `src/app/op-log/backup/state-snapshot.service.ts:294`: remove the `PfapiStoreDelegateService` alias export after grepping for consumers (none found outside the file today; re-verify).
- Delete commented-out `_pfapiService` blocks in `src/app/features/project/store/project.effects.ts:78-93` and `src/app/features/work-context/work-context.service.ts:593`.
- Reword comments that imply a live `PfapiService` in `src/app/op-log/util/client-id.provider.ts`, `src/app/op-log/apply/archive-operation-handler.service.ts:298`, `src/app/plugins/plugin.service.ts:1906`. Keep comments that correctly describe the *legacy on-disk format* (e.g. `__meta_` detection in `file-based-sync-adapter.service.ts`).
- `npm run checkFile` on every touched `.ts`.

**Phase 3 — sunset doc (one commit, `docs(sync): document legacy pfapi compat sunset`):**
- Add a section to `docs/sync-and-op-log/README.md` (or a new short page) enumerating the live legacy surface — `LegacyPfDbService`, `ClientIdService` legacy fallback, `SyncWrapperService._syncVectorClockToPfapi()`, `LegacySyncFormatDetectedError` — and the maintainer-chosen earliest removal version.

**Risks:** essentially none for Phase 1 (dead code); Phase 2 is comment/alias-only — the one real check is that no spec imports the `PfapiStoreDelegateService` alias. **Explicitly out of scope:** touching `LegacyPfDbService` or the vector-clock bridge — that is live sync-correctness code; removing it early strands v16 clients sharing a file-based remote.

### Item 2: NgModule retirement (~1–2 days)

**Phase 1 — `reminder.module.ts` → initializer (the only behavioral change):**
- Create `src/app/features/reminder/reminder-init.service.ts` (`providedIn: 'root'`) and move the constructor body into an `init()` method; keep all injected deps. Subscriptions move out of a constructor (fixes the documented anti-pattern); add `takeUntilDestroyed()` where missing.
- Wire via `provideAppInitializer(() => inject(ReminderInitService).init())` in `main.ts` (or call from the existing startup sequencing in `src/app/core/startup/startup.service.ts` if ordering relative to `afterInitialSyncDoneAndDataLoadedInitially$` matters — it self-gates on that observable, so plain init is safe). Remove `ReminderModule` from `main.ts:54,149` and delete the file.
- **Sync-correctness check:** the moved code dispatches user-intent actions from notification taps (`TaskSharedActions.*`) — it is an action *producer*, not an effect, so LOCAL_ACTIONS rules don't bite; no behavior change as long as init still runs exactly once at bootstrap.
- Test strategy: new `reminder-init.service.spec.ts` covering the Android/iOS action handlers (snooze/done/tap paths are pure dispatch logic, easy to spec); manual smoke on web (`ng serve`) that the reminder dialog still appears.
- Estimated size: ~1 day, mostly mechanical move + spec.

**Phase 2 — delete re-export modules (trivial):**
- `task-title.component.ts`, `add-task-bar.component.ts`: replace `MentionModule` with direct `MentionDirective` / `MentionListComponent` imports; delete `src/app/ui/mentions/mention.module.ts`.
- `formly-config.module.ts`: replace `ValidationModule` with `MinDirective`, `MaxDirective`; delete `src/app/ui/validation/validation.module.ts`.
- `npm run checkFile` each touched file; existing component specs cover regressions.

**Phase 3 — explicitly close the remaining two:** add one-line comments (already half-present) to `formly-config.module.ts` and `feature-stores.module.ts` stating they are intentional root-only aggregators, and tick them off in this issue as "kept by design".

### Other items — disposition only

- **Item 3 (Signals):** policy PR + one flagship conversion only; no bulk migration (each selector-based seam touched is sync-window-sensitive — cost exceeds value).
- **Item 4 (platform detection):** owned by issue 03; no work here.
- **Item 5 (build tooling):** no work; close as reviewed-and-fine.

## Verification notes

- **Seed 1 (pfapi remnants) — partially corrected.** Confirmed `src/app/pfapi/` holds only deprecated compiled `.js` (4 files), but the claim that they are "still loaded for back-compat" is **false**: zero import/require/build-config references anywhere (`grep` across `src/`, `electron/`, `angular.json`, tsconfigs), and `api/index.js` requires nonexistent files, so it cannot load. The real back-compat path is `LegacyPfDbService` (410 LOC, direct IndexedDB) + `_syncVectorClockToPfapi()` at `sync-wrapper.service.ts:1523` + `LegacySyncFormatDetectedError` handling. `sync-wrapper.service.ts` is exactly 1,542 LOC as claimed, but it is the live op-log orchestration/UI layer, **not** legacy glue — kept, reclassified.
- **Seed 2 (standalone ~32%, one NgModule) — corrected in both directions.** Component migration is effectively 100%: 247 components, zero `standalone: false`, zero NgModule `declarations` (counted NgModules per the seed's own advice). But **5** NgModules remain, not 1: `reminder.module.ts` (logic-in-constructor, the only problematic one), `mention.module.ts` + `validation.module.ts` (re-export shims), `formly-config.module.ts` + `feature-stores.module.ts` (intentional root aggregators). Also found 121 redundant `standalone: true` flags.
- **Seed 3 (Observable/Signal twins) — confirmed and quantified.** `task.service.ts:131-158` shows the literal twin pattern; repo-wide: 145 public `X$` service members vs 63 service `toSignal` members, 37 `| async` templates, 11 services with `BehaviorSubject`, 17+ services mixing both.
- **Seed 4 (IS_ANDROID_WEB_VIEW ~63 files) — corrected.** 36 non-spec files (44 incl. specs); referenced to issue 03 only, per instructions.
- **Seed 5 (build tooling) — corrected/downgraded.** Three tsc paths confirmed (Angular CLI, `electron/tsconfig.electron.json`, `packages/*`), but `bundle-preload.js` is a 15-line esbuild wrapper, not a hand-rolled bundler. Assessed honestly as fine-as-is; recommended no action.
- **Dropped:** nothing wholesale; every seed item appears in the issue, two as no-action/deferred items.
