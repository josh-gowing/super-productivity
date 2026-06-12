# Introduce capability-based platform abstraction; stop spreading raw IS_ELECTRON / IS_ANDROID_WEB_VIEW checks through feature code

## Issue draft (for GitHub)

### Problem

Platform conditionals are scattered across the entire frontend instead of being concentrated behind an abstraction. Feature code (take-a-break, tasks, issue providers, config forms) directly asks "am I on Electron?" rather than "can this platform lock the screen / detect idle / save a clipboard image?". As a result:

- Any new platform target (Tauri, browser extension, a second mobile shell) or any change to platform behavior touches dozens of unrelated feature files.
- The same product decision ("scheduled reminders exist on native platforms") is re-derived ad hoc at every call site with slightly different boolean algebra (`IS_ELECTRON || IS_ANDROID_WEB_VIEW`, `!IS_ELECTRON && !IS_NATIVE_PLATFORM`, …), which drifts.
- Web/no-op fallbacks are reimplemented per call site instead of once per capability.

### Evidence (verified 2026-06-12 against `master`)

**Raw platform checks:**

- `IS_ELECTRON`: **228 occurrences in 72 files** under `src/app` (`grep -ro IS_ELECTRON src/app --include="*.ts"`), plus 5 usages in component templates (`formly-image-input.component.html:18`, `icon-input.component.html:30`, `clipboard-images-cfg.component.html:2,17`, `plugin-management.component.html:145`). **87 of those occurrences (27 files) are inside `src/app/features/`** — i.e. business logic, not platform glue.
- `IS_ANDROID_WEB_VIEW` / `IS_IOS_NATIVE` / `IS_NATIVE_PLATFORM`: **58 files** under `src/app`.
- Worst files by `IS_ELECTRON` count:
  - `src/app/core/startup/startup.service.ts` — 10
  - `src/app/core/ipc-events.ts` — 10 (every exported IPC stream is wrapped in `IS_ELECTRON ? ipcEvent$(...) : EMPTY`)
  - `src/app/features/take-a-break/take-a-break.service.ts` — 8 (lines 82, 161, 174, 230, 276, 279, 282)
  - `src/app/core/clipboard-image/clipboard-image.service.ts` — 7
  - `src/app/features/config/form-cfgs/sync-form.const.ts` — 4 × `IS_ELECTRON` + 4 × `IS_ANDROID_WEB_VIEW` + 3 × `IS_NATIVE_PLATFORM` (e.g. lines 62, 172, 186, 220, 263)

**Three competing detection mechanisms coexist** (four counting raw Capacitor calls):

1. `IS_ELECTRON` — user-agent sniff at `src/app/app.constants.ts:3`.
2. `IS_ANDROID_WEB_VIEW` / `IS_F_DROID_APP` (`src/app/util/is-android-web-view.ts`, checks `window.SUPAndroid`) and `IS_NATIVE_PLATFORM` / `IS_IOS_NATIVE` / `IS_ANDROID_NATIVE` (`src/app/util/is-native-platform.ts`, wraps Capacitor).
3. `CapacitorPlatformService` (`src/app/core/platform/capacitor-platform.service.ts`) — already the right shape: a `PlatformType` plus a `PlatformCapabilities` flag set (`src/app/core/platform/platform-capabilities.model.ts`). But it is injected in only **8 non-spec files**, and it *re-implements* the Electron UA sniff privately (`_isElectron()`, lines 167–169) instead of sharing one source of truth.
4. Direct `Capacitor.*` calls in 7 additional non-spec files.

**Electron bridge:** `window.ea` is referenced in **47 files** under `src/app`. Contrary to a common assumption, it is *not* untyped — `electron/electronAPI.d.ts` (277 lines, ~73 methods) types the renderer side via `src/app/core/window-ea.d.ts`, and `contextBridge` isolation in `electron/preload.ts` is sound. The real gaps are:

- Renderer→main typing rests on hand-maintained `as` casts in `electron/preload.ts` (e.g. `_invoke('GET_PATH', 'userData') as Promise<string>`); nothing checks that the `ipcMain` handlers in `electron/ipc-handlers/*` actually return those shapes.
- Main→renderer events are stringly typed: `ea.on(channel: string, ...args: unknown[])` and `ipcEvent$(evName: string): Observable<unknown[]>` (`src/app/util/ipc-event.ts`) carry no payload types; consumers re-cast (`idleTimeInMs as number`) and hand-validate (`ipcAddTaskFromAppUri$`).
- `updateTodayTasks: (tasks: any[])` in `preload.ts:250` is an `any` leak.

### Risk of doing nothing

Each new platform-dependent feature adds more call sites (the count only grows), each new platform target requires editing ~100+ files, and behavioral drift between platforms is invisible until a user on the minority platform reports it. The existing `CapacitorPlatformService` shows the team already wants capability flags; without enforcement, new code keeps importing the raw constants because that's what the surrounding code does.

### Proposed direction

1. **One source of platform truth.** Keep the raw constants (`IS_ELECTRON` etc. are needed for module-load-time evaluation, e.g. formly form consts) but make them an internal implementation detail of a single `src/app/core/platform/` module. `CapacitorPlatformService` (rename to `PlatformService`) reuses `IS_ELECTRON` instead of its private duplicate UA sniff.
2. **Capabilities, not platforms, in feature code.** Extend `PlatformCapabilities` with the flags features actually branch on today (idle detection, screen lock, full-screen blocker, tray/progress bar, global shortcuts, clipboard images, native file dialogs, app relaunch/exit). Feature code asks `platformService.capabilities.canLockScreen`, never `IS_ELECTRON`.
3. **Capability services behind DI tokens** for behavior (not just flags): e.g. `IDLE_DETECTOR`, `BREAK_ENFORCER`, `CLIPBOARD_IMAGE_STORE`, `FILE_PICKER`, `APP_WINDOW`. Each has an Electron implementation (wrapping `window.ea`), a Capacitor/Android implementation where applicable, and a web no-op/fallback. Providers are selected once in app bootstrap. A future Tauri target implements N small interfaces instead of touching 100+ files.
4. **Typed inbound IPC contract.** Add an event→payload type map next to `IPC` in `electron/shared-with-frontend/`, make `ipcEvent$` generic over it, and make it return `EMPTY` when `window.ea` is absent — which alone deletes all 10 `IS_ELECTRON` ternaries in `src/app/core/ipc-events.ts`.
5. **Ratchet, don't rewrite.** A new local ESLint rule bans importing the raw constants and `window.ea` outside `src/app/core/platform/` (and other designated glue), seeded with a baseline of the current legacy files. The baseline can only shrink; new files must use the abstraction. 228 call sites migrate over many small PRs, hotspots first.

Explicitly **not** proposed: a big-bang rewrite, changing `contextBridge` usage, or migrating Android/iOS bridge files (`src/app/features/android/`, `src/app/features/ios/`) that are *supposed* to be platform-specific.

### Acceptance criteria

- [ ] Single platform-detection module; `CapacitorPlatformService` no longer duplicates the Electron UA sniff.
- [ ] `PlatformCapabilities` covers the branches used by the top-5 hotspot files; capability flags documented per platform.
- [ ] ESLint rule (`eslint-local-rules/`) banning raw `IS_ELECTRON` / `IS_ANDROID_WEB_VIEW` / `IS_NATIVE_PLATFORM` / `IS_IOS_NATIVE` imports and direct `window.ea` access outside an explicit baseline + allowlisted glue directories; CI-enforced.
- [ ] Baseline shrinks: `src/app/core/ipc-events.ts`, `take-a-break.service.ts`, and `clipboard-image.service.ts` are off the baseline (0 raw checks).
- [ ] Inbound IPC events have a typed contract shared between `electron/` and `src/app`; `ipcEvent$` payloads are no longer `unknown[]` at call sites.
- [ ] App remains shippable after every phase; no behavior change on any platform (verified per phase, see plan).

## Implementation plan

Phases are ordered so each ships independently and the app is releasable after every one. Sizes: S ≈ ≤1 day, M ≈ 2–4 days, L ≈ 1–2 weeks.

### Phase 1 — Single source of platform truth (S)

- **Files:** `src/app/core/platform/capacitor-platform.service.ts`, `src/app/core/platform/platform-capabilities.model.ts`, `src/app/app.constants.ts`, `src/app/util/is-native-platform.ts`, `src/app/util/is-android-web-view.ts`.
- Make `_isElectron()` in `CapacitorPlatformService` delegate to `IS_ELECTRON` (delete the duplicated UA sniff). Re-export all raw constants from one barrel (`src/app/core/platform/index.ts`) so the lint rule in Phase 2 has a single allowed import path for glue code.
- Extend `PlatformCapabilities` with the flags needed by later phases: `idleDetection`, `lockScreen`, `fullScreenBlocker`, `flashFrame`/`progressBar`, `globalShortcuts`, `clipboardImages`, `nativeFileDialogs`, `appRelaunch`. Fill in the four platform constant objects.
- Optionally alias the service as `PlatformService` (new name, old kept as deprecated re-export) since it now covers Electron, not just Capacitor.
- **Tests:** extend `capacitor-platform.service.spec.ts` (exists implicitly via `capacitor-reminder.service.spec.ts` patterns); table-test capability matrices per `PlatformType`.
- **Risk:** near zero — no behavior change; pure consolidation.

### Phase 2 — Ratchet mechanism (S/M)

- **Files:** new `eslint-local-rules/rules/no-raw-platform-detection.js` (+ `.spec.js`, runner: `eslint-local-rules/run-specs.js`), `eslint-local-rules/index.js`, `eslint.config.js`.
- Rule bans (a) importing `IS_ELECTRON` from `app.constants`, anything from `util/is-native-platform` / `util/is-android-web-view`, and `@capacitor/core`'s `Capacitor` for platform sniffing; (b) member access on `window.ea` — everywhere under `src/app` **except** `src/app/core/platform/**` and an explicit baseline.
- Baseline: a checked-in JSON (e.g. `eslint-local-rules/platform-check-baseline.json`) listing the current ~85 legacy files (72 `IS_ELECTRON` files ∪ 58 native-constant files ∪ `window.ea` files), generated once by script. Rule severity: `error` for non-baseline files, silent for baseline files. A tiny spec asserts the baseline only ever shrinks (compare against committed list length) — or simpler: PR reviewers enforce "no additions" since any addition is a visible diff in the JSON.
- Mirrors the existing pattern (`no-actions-in-effects`, `require-hydration-guard` at `eslint.config.js:221-223`), so contributors already know the mechanic.
- Document the rule + migration recipe in `CLAUDE.md` anti-patterns table.
- **Tests:** rule unit specs via `run-specs.js`.
- **Risk:** none at runtime; main cost is baseline-generation script accuracy.

### Phase 3 — Typed inbound IPC contract (M)

- **Files:** `electron/shared-with-frontend/ipc-events.const.ts` (add `IpcEventPayloadMap` interface mapping `IPC.*` → payload tuple types), `src/app/util/ipc-event.ts`, `src/app/core/ipc-events.ts`, `electron/preload.ts` (fix `tasks: any[]` at line 250), consumers of `ipcEvent$` (grep shows they're concentrated in `core/ipc-events.ts`, idle, focus-mode).
- `ipcEvent$<K extends keyof IpcEventPayloadMap>(evName: K): Observable<IpcEventPayloadMap[K]>`; return `EMPTY` (not `devError`) when `window.ea` is missing → delete all 10 `IS_ELECTRON ? … : EMPTY` ternaries in `core/ipc-events.ts` and remove both files from the baseline.
- On the main-process side, add a thin typed `sendToRenderer<K>(win, ev, payload)` helper in `electron/` so emit sites are checked against the same map (incremental adoption; raw `webContents.send` keeps working).
- **Tests:** compile-time is the main win; add a spec for `ipcEvent$` web fallback behavior.
- **Risk:** low; the `devError`→`EMPTY` change alters web-dev console noise only. Verify Electron e2e smoke (idle, add-task-from-uri) still passes.

### Phase 4 — First capability extraction: break enforcement + idle (M)

- **Files:** new `src/app/core/platform/capabilities/` (interfaces + tokens + electron/web/android providers), `src/app/features/take-a-break/take-a-break.service.ts` (8 checks), `src/app/features/idle/` consumers of `ipcIdleTime$`.
- `BREAK_ENFORCER` token: `{ lockScreen(): void; showFullScreenBlocker(cfg): void; focusWindow(): void; isAvailable: …flags }` — Electron impl wraps `window.ea.lockScreen/showFullScreenBlocker/showOrFocus`; web impl is a no-op that the capability flags gate in the settings UI.
- `IDLE_DETECTOR` token wrapping `ipcIdleTime$` (Electron) / Android bridge where applicable.
- This is the template PR for all later extractions — keep it small and exemplary.
- **Tests:** unit tests for each provider (token-swapped fakes); existing take-a-break specs keep passing.
- **Risk:** medium — take-a-break touches reminders/notifications timing; manually verify break lock/blocker on Electron and that web build shows no regressions. No sync-state interaction (none of this is synced state, so op-log rules aren't in play; effects touched must still inject `LOCAL_ACTIONS`).

### Phase 5 — Clipboard images + file access capabilities (M)

- **Files:** `src/app/core/clipboard-image/clipboard-image.service.ts` (7 checks), `src/app/util/download.ts`, `src/app/imex/file-imex/file-imex.component.ts`, `src/app/imex/local-backup/local-backup.service.ts`.
- `CLIPBOARD_IMAGE_STORE` and `FILE_PICKER`/`FILE_SAVER` tokens; Electron impls wrap the ~10 `CLIPBOARD_IMAGE_*` and dialog methods on `window.ea`; web impl uses existing browser fallbacks already present in these files (the branches just move into providers).
- Remove these files from the lint baseline.
- **Tests:** unit tests per provider; e2e attachment/clipboard flows on Electron.
- **Risk:** medium — file paths and backup loading are user-data-adjacent; test backup restore on Electron explicitly.

### Phase 6 — Config forms: capability flags at module-load time (M)

- **Files:** `src/app/features/config/form-cfgs/sync-form.const.ts` (11 platform conditionals), `reminder-form.const.ts`, `global-config-form-config.const.ts`, `common-issue-form-stuff.const.ts`.
- Constraint: these are module-scope consts evaluated at load time, so DI is unavailable. Solution: a static `PLATFORM_FLAGS`/`STATIC_CAPABILITIES` object exported from `src/app/core/platform/` (computed from the same constants Phase 1 consolidated). Forms read `PLATFORM_FLAGS.capabilities.localFileSync` etc. — semantically named, single-sourced, still load-time. Longer term these forms could become factories, but that's out of scope.
- **Tests:** snapshot-ish specs asserting which form fields appear per simulated platform (inject flags via the existing `IS_ANDROID_WEB_VIEW_TOKEN` pattern where possible).
- **Risk:** low–medium; a wrong flag hides a settings section on one platform — review the per-platform field matrix carefully.

### Phase 7 — Ongoing ratchet (S each, continuous)

- Opportunistic migrations: any PR touching a baseline file should migrate that file's checks (or consciously defer). Track progress with the baseline count in the JSON diff. Hot candidates next: `startup.service.ts` (10 — partially migrated already, it injects the platform service), `jira-api.service.ts` (6 + 5 native), `sync-trigger.service.ts`, `plugin.service.ts`.
- Out of scope / never migrate: `src/app/features/android/**`, `src/app/features/ios/**`, `src/app/core/platform/**`, `electron/**` — these *are* the platform layer.

**Estimated end state after Phases 1–6:** raw checks in `src/app/features/` drop from 87 `IS_ELECTRON` occurrences to roughly half, all five hotspot files clean, and — more importantly — the count can no longer grow.

## Verification notes

- **Confirmed:** `IS_ELECTRON` count — 228 occurrences in `src/app` (`grep -ro`), seed's "~228" exact. File count is **72**, not ~78 (seed slightly high). Additionally found 5 template (`.html`) usages the seed missed.
- **Corrected:** native-platform constants — **58 files**, not ~63 (`grep -rlE "IS_ANDROID_WEB_VIEW|IS_IOS_NATIVE|IS_NATIVE_PLATFORM" src/app --include="*.ts"`).
- **Corrected (file path):** hotspot is `src/app/core/ipc-events.ts` (10 checks), not `util/ipc-event.ts` as seeded — `util/ipc-event.ts` is the `ipcEvent$` helper (1 check). Other hotspots confirmed with exact counts: `startup.service.ts` 10, `take-a-break.service.ts` 8, `clipboard-image.service.ts` 7, `sync-form.const.ts` 4 `IS_ELECTRON` + 7 native-constant occurrences.
- **Corrected (materially):** the seed claim "preload exposes ~60+ **untyped** methods via `window.ea`" is wrong. `electron/electronAPI.d.ts` (277 lines, ~73 method signatures) fully types the bridge, wired to the renderer via `src/app/core/window-ea.d.ts`. The accurate criticism, used in the issue: typing rests on unchecked `as` casts in `preload.ts` (no contract with `electron/ipc-handlers/*`), the **inbound** event side is stringly typed (`ea.on(channel: string, ...args: unknown[])`, `ipcEvent$` returns `Observable<unknown[]>`), and one `any` leak exists at `preload.ts:250`. `contextBridge` isolation confirmed sound (`preload.ts:312`).
- **Confirmed:** three competing detection mechanisms — `app.constants.ts:3` UA sniff, `util/is-android-web-view.ts` (`window.SUPAndroid`) + `util/is-native-platform.ts` (Capacitor), and `CapacitorPlatformService` with its own duplicate UA sniff at `capacitor-platform.service.ts:167-169`. Plus direct `Capacitor.*` calls in 7 further non-spec files (arguably a fourth mechanism).
- **Confirmed:** `CapacitorPlatformService` underutilized — injected in only 8 non-spec files; its `PlatformCapabilities` model (`platform-capabilities.model.ts`) already covers 9 capability flags across 4 platforms, validating the capability-flag direction.
- **Confirmed:** `electron/shared-with-frontend/` holds the shared `IPC` enum (`ipc-events.const.ts`) plus 8 other shared modules — the natural home for the typed event-payload map.
- **Confirmed (ratchet feasibility):** custom lint infrastructure exists at `eslint-local-rules/` with specs (`run-specs.js`) and is already wired in `eslint.config.js:215-226` (`no-actions-in-effects`, `require-hydration-guard`, etc.), so the proposed baseline rule follows an established repo pattern.
- **Adopted with evidence:** "business logic knows about Electron" — 87 `IS_ELECTRON` occurrences in 27 files under `src/app/features/`, and `window.ea` referenced in 47 files across `src/app`; a new platform target indeed touches 100+ files today.
