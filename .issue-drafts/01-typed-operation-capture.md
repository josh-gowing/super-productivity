# Make operation capture structurally enforced instead of convention-based

## Issue draft (for GitHub)

### Problem

Whether a state change survives sync depends on conventions the type system cannot see. Sync correctness rests on every contributor remembering to hand-write an untyped `meta` block on every action creator, on lint rules, and on a startup validation that is disabled in production builds.

Concretely, four gaps:

1. **Operation capture is opt-in via an untyped flag.** An action is captured into the op-log only if it carries `meta.isPersistent === true` (`src/app/op-log/core/persistent-action.interface.ts:31-34`, checked in `src/app/op-log/capture/operation-capture.meta-reducer.ts:222`). The `meta` block is attached manually in each creator's props factory — 131 occurrences of `isPersistent: true` across 19 `*.actions.ts` files. Nothing forces a *new* state-changing action to carry `meta` at all: NgRx `createAction` compiles fine without it, the reducer updates local state, and the change is silently never synced. The only existing guardrail is inverted — `operation-log.effects.ts:152-160` `devError`s when an action that *already has* the flag has a type missing from the `ActionType` enum; an action missing the flag entirely triggers nothing.

2. **Replay/remote suppression is a runtime filter, not a type.** `LOCAL_ACTIONS` (`src/app/util/local-actions.token.ts:46-55`) is the standard `Actions` stream with `meta?.isRemote` filtered out (`(action as any).meta?.isRemote`). Discipline is enforced only by custom lint rules (`local-rules/no-actions-in-effects` error, `require-hydration-guard` error, heuristic `no-multi-entity-effect` warn — `eslint.config.js:221-224`). These work, but they are the *only* layer; nothing in the type system distinguishes a local action from a replayed one.

3. **Meta-reducer ordering is validated only in dev.** The chain in `src/app/root-store/meta/meta-reducer-registry.ts:77-138` has **17** meta-reducers across **9** documented phases (1, 2, 3, 3.5, 4–8) with hard ordering constraints ("if moved, operation logs will capture post-modification state"). `validateMetaReducerOrdering()` (line 151) early-returns when `!isDevMode()`, so a production build never checks the one invariant the file calls CRITICAL. The validation is four array lookups — there is no cost reason for the gate. (Separately, the registry's Phase 1 comment "captures original state BEFORE modifications" is stale: the capture meta-reducer no longer diffs state and documents itself as position-independent, `operation-capture.meta-reducer.ts:199-213`. The dev-only validator enforces a constraint whose stated rationale no longer exists — nobody can tell which ordering rules are still load-bearing.)

4. **Synthetic LWW action types live outside the `ActionType` enum behind an unsound cast.** LWW types are *not* regex-matched (an earlier review claimed this; it is no longer true) — they are built from `ENTITY_TYPES` into a typed `Set`/`Map` by `createLwwUpdateActionTypeHelpers` (`packages/sync-core/src/lww-update-action-types.ts:28-45`) and looked up exactly in `src/app/root-store/meta/task-shared-meta-reducers/lww-update.meta-reducer.ts:416`. The remaining gap is at the type level: `Operation.actionType` is declared as the `ActionType` enum (`src/app/op-log/core/operation.types.ts:61`), the enum contains **zero** LWW members (`src/app/op-log/core/action-types.enum.ts`), and the app-side shim papers over this with `as ActionType` (`src/app/op-log/core/lww-update-action-types.ts:15-16`). Every LWW op (`conflict-resolution.service.ts:158,748`) carries an `actionType` the type system believes is an enum member but isn't, so exhaustiveness checks and the enum-membership `devError` are structurally unable to cover the LWW family.

A fifth, related item is documented debt rather than a gap: the capture meta-reducer uses module-level mutable state (service set via `setOperationCaptureService()`, `isApplyingRemoteOps` flag, deferred-action buffer — `operation-capture.meta-reducer.ts:10-41, 50, 74-91`) because NgRx meta-reducers cannot use DI. The header comment explicitly accepts this and lists refactoring options.

### Risk

A contributor adding a new feature store (or a new action to an existing one) and forgetting the `meta` block gets a fully working app locally and **silent data divergence across devices** — the worst failure mode the sync model has, and the capture meta-reducer itself notes the consequence: local state diverges "until a SYNC_IMPORT (full state sync) is triggered" (`operation-capture.meta-reducer.ts:274-276`). A misordered meta-reducer registry edit that slips past dev testing ships unvalidated. The LWW cast means a typo'd or stale synthetic type fails only at runtime, with `devError` (no-op in prod).

### Proposed direction

1. **`createPersistentAction` factory + lint ratchet** (the main fix). A thin wrapper over NgRx `createAction` that (a) constrains `type` to the `ActionType` enum, so registering the type and creating the action become one step, and (b) requires a typed `PersistentActionMeta` builder, making `isPersistent: true` a literal the factory supplies. The factory alone can't stop someone calling raw `createAction` — pair it with a new local lint rule that errors on raw `createAction` in `*.actions.ts` files unless the creator is wrapped in an explicit `createLocalOnlyAction` (or carries a justification comment), so every action is *explicitly* synced or *explicitly* local. Migrate the 131 existing creators mechanically (the emitted action objects must be byte-identical — see plan).
2. **Run `validateMetaReducerOrdering()` in production** (delete the `isDevMode()` gate; it's a handful of identity comparisons at module load), export it, add a unit test, and reconcile the stale Phase 1 rationale so the validator only asserts constraints that are still true.
3. **Make LWW action types a real type.** Add `type LwwUpdateActionType = `[${EntityType}] LWW Update`` (template-literal type derived from `ENTITY_TYPES`), change `Operation.actionType` to `ActionType | LwwUpdateActionType`, delete the `as ActionType` cast.
4. **(Optional, separable)** Narrow the capture meta-reducer's module-level state behind a single injectable bridge created via a `META_REDUCERS`-style factory closure. Evaluated below; recommended as a follow-up only, not bundled with 1–3.

### Acceptance criteria

- [ ] A new action whose `type` is not in `ActionType`, or whose meta is missing/mistyped, **fails to compile** when created via the factory; raw `createAction` in `*.actions.ts` **fails lint** unless explicitly marked local-only.
- [ ] All 131 existing persistent creators across the 19 action files migrated; emitted action `type` strings and payload/meta shapes are provably unchanged (snapshot/round-trip tests, see plan).
- [ ] `validateMetaReducerOrdering()` runs in production builds and is covered by a unit test; registry comments describe only constraints the validator actually enforces.
- [ ] `Operation.actionType` admits LWW types without casts; `toLwwUpdateActionType` has no `as`.
- [ ] No change to any persisted action-type string, op encoding, or replay behavior (existing `persistent-action-types.spec.ts` stability tests and op-log integration specs stay green).

## Implementation plan

### Phase 1 — Production ordering validation + doc reconciliation (S)

Independently shippable; zero migration surface.

- `src/app/root-store/meta/meta-reducer-registry.ts`
  - Remove the `if (!isDevMode()) return;` gate (lines 151-153). Keep `throw` semantics: the registry is a static array, so any violation is deterministic, reproducible in dev/CI, and cannot brick only-production. Export `validateMetaReducerOrdering` for testing.
  - Reconcile the stale Phase 1 comment (lines 29-31, 81-83 claim before-state capture; `operation-capture.meta-reducer.ts:199-213` says position-independent enqueue). Either drop the index-0 constraint with a comment explaining why it's now soft, or keep it as a defensive freeze with an honest rationale ("position-independent today; pinned to avoid silent semantic drift"). Decide explicitly — do not leave the contradiction.
- Tests: new `meta-reducer-registry.spec.ts` asserting the validator passes on the real array and fails on deliberately reordered copies (export a pure `validateOrdering(reducers: MetaReducer[])` to make the negative cases testable).
- Sync risk: none at steady state — runtime change is confined to one module-load check. The only behavior change is fail-fast at startup instead of silent misordering, which is the point.

### Phase 2 — Sound LWW action-type typing (S)

Independently shippable; type-level only, no runtime change.

- `packages/shared-schema/src/entity-types.ts` (or a sibling in `packages/sync-core/src/lww-update-action-types.ts`): add ``export type LwwUpdateActionType<T extends string = EntityType> = `[${T}] LWW Update`;`` — keep the `'] LWW Update'` suffix constant as the single source for both the type and `createLwwUpdateActionTypeHelpers` so they cannot drift.
- `src/app/op-log/core/operation.types.ts:61`: `actionType: ActionType | LwwUpdateActionType;` (consider a named alias `OperationActionType`). Chase resulting type errors — expected in `operation-converter.util.ts`, `conflict-resolution.service.ts`, and specs; they should all *narrow*, not cast.
- `src/app/op-log/core/lww-update-action-types.ts:15-16`: delete the `as ActionType` cast; return type becomes `LwwUpdateActionType`.
- Optionally tighten `operation-log.effects.ts:152-160` to also accept `isLwwUpdateActionType()` if any dispatch path can ever reach it with an LWW action (today LWW ops are written directly by `conflict-resolution.service.ts`, not dispatched locally — verify with a spec rather than assuming).
- Tests: `npm run checkFile` on touched files; existing `lww-update.meta-reducer.spec.ts`, `bulk-hydration.meta-reducer.spec.ts`, `conflict-resolution` specs must pass untouched (proves no runtime change).
- Sync risk: none if the suffix constant is shared. The hard invariant: **the produced strings must remain exactly `[<ENTITY>] LWW Update`** — these are persisted in IndexedDB op logs and on the SuperSync server; any change breaks replay of existing logs.

### Phase 3 — `createPersistentAction` factory + migration + lint ratchet (the core; M overall, split 3a/3b/3c)

**3a — Factory + pilot store (M).** New `src/app/op-log/core/persistent-action.factory.ts`:

```ts
export const createPersistentAction = <T extends ActionType, P extends object>(
  type: T,
  propsFn: (props: P) => Omit<P, 'meta'> & { meta: Omit<PersistentActionMeta, 'isPersistent' | 'isRemote'> },
) => createAction(type, (props: P) => {
  const r = propsFn(props);
  return { ...r, meta: { ...r.meta, isPersistent: true as const } };
});
```

Design points to settle in 3a (with the pilot, e.g. `note.actions.ts` — small, 5 creators):
- `type` constrained to `ActionType` makes enum registration compile-enforced, retiring the `devError` heuristic at `operation-log.effects.ts:154` for factory-made actions (keep the runtime check for stragglers until 3b completes).
- The factory must reproduce the **exact** current emitted object: same key order is irrelevant, but same keys/values — operations serialize the action payload, and `convertOpToAction` (`src/app/op-log/apply/operation-converter.util.ts`) round-trips it on every replay. Add a snapshot-style spec comparing factory output to the legacy creator output for the pilot store before deleting the legacy creator.
- `isRemote` must *not* be settable through the factory — only `convertOpToAction` (line 222) may set it. Omitting it from the builder type makes "a local creator that fakes remoteness" unrepresentable.
- Make `PersistentActionMeta.isPersistent` a required `true` literal on a new `CapturedActionMeta` type used by the factory. Note: the interface comment "When false, the action is blacklisted and not persisted" (`persistent-action.interface.ts:5`) is vestigial — `isPersistentAction` checks `=== true`, so `false` and absent are identical; there are zero `isPersistent: false` usages in non-spec code. Clean up the comment.

**3b — Mechanical migration of remaining 18 action files, ~126 creators (M, mechanical; can land file-by-file).** Files (verified list): `task.actions.ts`, `task-shared.actions.ts`, `project.actions.ts`, `tag.actions.ts`, `note.actions.ts`, `section.actions.ts`, `boards.actions.ts`, `archive.actions.ts`, `issue-provider.actions.ts`, `simple-counter.actions.ts`, `metric.actions.ts`, `task-attachment.actions.ts`, `global-config.actions.ts`, `planner.actions.ts`, `work-context-meta.actions.ts`, `menu-tree.actions.ts`, `plugin.actions.ts`, `time-tracking.actions.ts`, `task-repeat-cfg.actions.ts`. Each PR: migrate one file, run its store specs + `persistent-action-types.spec.ts` (type-string stability) + the op-log integration suite (`src/app/op-log/testing/integration/`).

**3c — Lint rule `require-persistent-action-factory` (S).** New rule in `eslint-local-rules/rules/` (pattern-match the existing three): in `**/*.actions.ts`, error on direct `createAction(...)` unless wrapped by `createPersistentAction` or an explicit `createLocalOnlyAction` re-export (a transparent alias of `createAction` whose name documents intent — e.g. `unsetCurrentTask` in `task.actions.ts:24` is genuinely local). Start as `warn` with a grandfather allowlist if 3b lands incrementally; flip to `error` when migration completes. Register in `eslint.config.js` next to lines 221-224. Add rule spec alongside the existing `*.spec.js` rule tests.

- Sync risks for Phase 3 (call out in every PR per CLAUDE.md): the migration touches the exact strings and payload shapes persisted in user op logs. Invariants: (1) action `type` strings byte-identical (covered by `persistent-action-types.spec.ts` — extend it to cover all 19 files, currently it covers ~7); (2) payload key set identical, since `OperationLogEffects` validates payloads (`validateOperationPayload`) and replay reconstructs actions from stored payloads; (3) no new fields in `meta` that would be serialized into ops. Any rename still requires `ACTION_TYPE_ALIASES` per the existing rule. One factory bug = corrupted ops on every device that upgrades, so 3a's output-equivalence snapshot test is not optional.

### Phase 4 (optional follow-up, do not bundle) — Injectable seam for capture meta-reducer state (M, highest risk/lowest payoff)

Evaluated per the debt header's own option list (`operation-capture.meta-reducer.ts:30-40`):
- Feasible shape: a root-provided `OperationCaptureBridgeService` owning the service ref, `isApplyingRemoteOps` flag, and deferred buffer; the meta-reducer becomes a factory `createOperationCaptureMetaReducer(bridge)` closed over the bridge. Purity is preserved — the closure is reference-stable and the reducer body stays synchronous; this is exactly NgRx's blessed `META_REDUCERS`-token pattern.
- Why defer: the registry currently composes a plain ordered array (`META_REDUCERS` const) passed to `StoreModule.forRoot`; moving one member behind a DI factory either splits ordering across two mechanisms (token-provided vs config-provided meta-reducers compose in a fixed but non-obvious relative order) or forces the whole registry into a factory provider. That interacts directly with Phase 1's ordering guarantees, and the current module-state design is, per its own header, "stable and well-tested" with an explicit warning logged on the only failure mode (use-before-init). Payoff is test ergonomics, not correctness.
- If pursued: whole-registry factory provider (keep one ordered array, built inside a `useFactory` with `inject()`), keep `validateMetaReducerOrdering()` running against the built array, and keep the module-level functions as deprecated shims for one release so specs migrate gradually. Sync risk: init-order regression here means ops silently dropped at startup — gate with an integration spec that dispatches a persistent action immediately after bootstrap and asserts capture.

**Recommended order: 1 → 2 → 3a → 3b → 3c; Phase 4 as a separate issue.**

## Verification notes

- **`meta.isPersistent` / `meta.isRemote` claim — confirmed.** Guard requires `isPersistent === true` (`src/app/op-log/core/persistent-action.interface.ts:31-34`); capture meta-reducer checks it plus `!meta.isRemote` (`operation-capture.meta-reducer.ts:222`); `convertOpToAction` sets `isRemote: true` on replay (`operation-converter.util.ts:222`). Counted **131** `isPersistent: true` creator sites across **19** `*.actions.ts` files (seed said "~18 feature stores" — close enough, corrected to 19 files). Nuance the seed missed: there *is* a runtime `devError` for flagged actions with unregistered types (`operation-log.effects.ts:152-160`), but nothing detects an action missing `meta` entirely — the silent-loss claim holds for that case. Also found: the `isPersistent: false` "blacklist" doc comment is vestigial (zero non-spec usages; `false` ≡ absent).
- **`LOCAL_ACTIONS` runtime filter claim — confirmed.** `src/app/util/local-actions.token.ts:46-55`, `filter(!(action as any).meta?.isRemote)`. Lint rules exist at stated severities (`eslint.config.js:221-224`: hydration-guard error, no-actions-in-effects error, no-multi-entity-effect warn), implemented in `eslint-local-rules/rules/`.
- **Meta-reducer chain claim — corrected.** The chain has **17** meta-reducers, not 13, across **9** labeled phases (1, 2, 3, 3.5, 4, 5, 6, 7, 8), not ~8. `validateMetaReducerOrdering()` dev-only early return confirmed (`meta-reducer-registry.ts:151-153`), invoked at module load (line 199). Additional finding: the registry's Phase-1 rationale contradicts the capture meta-reducer's own header (state diffing removed; "can be registered at any position", `operation-capture.meta-reducer.ts:199-213`) — folded into Phase 1 of the plan.
- **LWW regex claim — corrected.** No regex and the seed's file path is wrong: the meta-reducer lives at `src/app/root-store/meta/task-shared-meta-reducers/lww-update.meta-reducer.ts` (not `root-store/meta/lww-update.meta-reducer.ts`) and matches via exact `Set`/`Map` lookup (`getLwwEntityType`, line 416) built from `ENTITY_TYPES` (21 entries, `packages/shared-schema/src/entity-types.ts:15-37`) by `createLwwUpdateActionTypeHelpers` (`packages/sync-core/src/lww-update-action-types.ts:28-45`). The *kernel of truth*: LWW strings are absent from the `ActionType` enum and reach `Operation.actionType: ActionType` (`operation.types.ts:61`) only via an unsound `as ActionType` cast (`src/app/op-log/core/lww-update-action-types.ts:15-16`) — the issue reframes the claim around that.
- **Module-level mutable state claim — confirmed.** `operation-capture.meta-reducer.ts:10-41` (debt header listing the same refactoring options the seed proposes), line 50 (service ref), line 74 (`isApplyingRemoteOps`), lines 80-91 (deferred buffer + WeakSet). Header explicitly calls it accepted debt: "Refactoring should be considered only if significant architectural changes are planned" — hence Phase 4 is recommended as optional/deferred.
- **No production factory exists** — `createPersistentAction` appears only as a local helper in two spec files (`operation-log.effects.spec.ts:39`, `operation-capture.service.spec.ts`), confirming greenfield for Phase 3a.
