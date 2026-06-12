# Unify issue-provider registration: one registry path for built-in and plugin providers

## Issue draft (for GitHub)

### Problem

The issue-provider system is mid-way through a migration and currently runs **two parallel extension mechanisms for the same concept**:

1. **Built-in providers** (9: Jira, GitLab, OpenProject, Redmine, Trello, Azure DevOps, Nextcloud Deck, CalDAV, Calendar/ICAL under `src/app/features/issue/providers/`) are wired through hardcoded maps: `ISSUE_SERVICE_MAP` in `src/app/features/issue/issue.service.ts:98-110` plus five parallel metadata const maps in `src/app/features/issue/issue.const.ts:67-139` (`ISSUE_PROVIDER_ICON_MAP`, `ISSUE_PROVIDER_HUMANIZED`, `DEFAULT_ISSUE_PROVIDER_CFGS`, `ISSUE_PROVIDER_FORM_CFGS_MAP`, `ISSUE_STR_MAP`).
2. **Plugin providers** (GitHub, Gitea, Linear, ClickUp — former built-ins now shipped as bundled plugins, see `src/app/plugins/plugin.service.ts:47-60` — plus CalDAV-calendar and Google-calendar) go through `PluginIssueProviderRegistryService` (131 LOC) + `PluginIssueProviderAdapterService` (628 LOC, implements `IssueServiceInterface` for all plugins at once).

Every consumer that needs provider metadata or behavior has to branch between the two worlds. `IssueService` alone has five private helpers with the same `if (this._pluginRegistry.hasProvider(key)) { ... } else { constMap[key] }` shape (`issue.service.ts:821-860`), and the same dual-path branching is repeated in ~10 more files: `issue-icon.pipe.ts:16`, `issue-content.component.ts:71-110`, `dialog-edit-issue-provider.component.ts` (25+ registry call sites), `issue-panel.component.ts:120-130`, `issue-provider-setup-overview.component.ts`, `poll-to-backlog.effects.ts:66,100`, `issue-header.component.ts`, `tag-list.component.ts`, calendar-integration services. In total 33 files reference the plugin registry/adapter, most of them only to do "plugin or built-in?" dispatch.

Adding a provider today means either writing a plugin (limited API, see gaps below) or touching the central service map, five const maps, the icon pipe assets, and the content/config dispatch — there is no single registration point.

### Evidence (verified 2026-06-12)

- `src/app/features/issue/issue.service.ts` — 906 LOC; `ISSUE_SERVICE_MAP` at line 98; registry-first fallback dispatch in `_getService` (line 821) and four more dual-path helpers (lines 830-860); injects all 9 common-interfaces services individually (lines 75-85).
- `src/app/features/issue/issue.const.ts:67-139` — five parallel per-provider const maps that must each be edited to add a built-in provider.
- `src/app/plugins/issue-provider/plugin-issue-provider-adapter.service.ts` — 628 LOC; a second, completely separate implementation of `IssueServiceInterface` semantics (error handling, remote-deletion detection, field mappings, tag mapping) that built-ins don't share.
- `src/app/plugins/issue-provider/plugin-issue-provider-registry.service.ts` — 131 LOC; supports `issueProviderKey` overrides (e.g. `'GITHUB'`) so migrated plugins keep stable task `issueType` keys (line 35).
- Bundled plugins auto-enabled as built-in replacements: `src/app/plugins/plugin.service.ts:47-60` and `:160-177`.

**Honest duplication assessment** (this is where a prior review overstated the problem):

- The common-interfaces layer is **already deduplicated**. All 9 built-in providers extend `BaseIssueProviderService` (`src/app/features/issue/base/base-issue-provider.service.ts`, 161 LOC), which provides shared `getById`, `searchIssues`, `getFreshDataForIssueTask(s)`, and config retrieval. The per-provider common-interfaces services are small (GitLab 105, Redmine 85, OpenProject 110 LOC) and mostly genuinely provider-specific (URL building, title formatting, `updated_at` field access).
- Real remaining duplication sits in the **API service layer**:
  - Jira (`jira-api.service.ts`, 1,011 LOC), Redmine (`redmine-api.service.ts:239-305`), and OpenProject (`open-project-api.service.ts`) each hand-roll a near-identical private `_sendRequest$` (HttpRequest construction, sent-event filtering, body unwrapping, `catchError` → snack) plus a `_checkSettings`/`_isValidSettings` + `throwHandledError` pair (~60-100 LOC each).
  - Error handling is **inconsistent**, not just duplicated: GitLab/Redmine/OpenProject use the shared `handleIssueProviderHttpError$` (`src/app/features/issue/handle-issue-provider-http-error.ts`, 68 LOC); Trello, Azure DevOps, and Nextcloud Deck each roll their own `_handleError` + snack logic; Jira has its own machinery; the plugin adapter has yet another error path (`PluginLog` + snack, 404/410 remote-deletion detection that built-ins lack).
  - Auth header construction is small but hand-rolled per provider (Redmine `X-Redmine-API-Key`, Azure DevOps/Nextcloud Deck `btoa` Basic, Jira Basic/Bearer/cookie, GitLab token), whereas plugins declare it once via `getHeaders()`.
  - Claims of duplicated *pagination* and *retry* logic did **not** hold up: pagination is provider-specific (only Jira has multi-page fetch logic, `jira-api.service.ts:399-481`), and there is essentially no retry logic anywhere.

### Why plugins can't simply absorb the built-ins (capability gaps)

The plugin issue-provider API (`packages/plugin-api/src/issue-provider-types.ts`) covers: search, getById, issue link, test connection, backlog polling, declarative config forms (incl. OAuth + dynamic options), declarative issue display + comments, two-way field mappings (`fieldMappings` → `IssueSyncAdapterResolverService`), create/update/delete issue, time-block events, remote-deletion states. It **cannot** express:

- `getMappedAttachments` (Jira `jira-common-interfaces.service.ts:94`, Trello `trello-common-interfaces.service.ts:67`).
- `getSubTasks` (CalDAV `caldav-common-interfaces.service.ts:192`).
- Provider-specific NgRx effects with Material dialogs: Jira transition + worklog dialogs (`jira-issue.effects.ts`), OpenProject transition/time-tracking (`open-project.effects.ts`), Redmine time posting (`redmine.effects.ts`), GitLab worklog-for-day dialog.
- Custom Angular config components (`jira-view-components/jira-cfg`, `open-project-view-components/openproject-cfg`, `nextcloud-deck-additional-cfg.component.ts`, `trello-view-components/trello_cfg`).
- Jira's Electron IPC request path (`window.ea.makeJiraRequest`, `jira-api.service.ts:687`) and extension/fetch fallbacks for CORS/self-signed setups.
- Deep calendar integration of ICAL (deterministic task IDs, `skipCalendarEvent`, agenda specifics baked into `IssueService.addTaskFromIssue`, `issue.service.ts:499-619`).

So "convert all built-ins to bundled plugins" is not achievable without a large plugin-API expansion, and for Jira/CalDAV/ICAL it is likely never worth it.

### Risk

- Provider keys (`task.issueType`, `IssueProvider.issueProviderKey`) are persisted in synced state; any unification must keep keys byte-identical (the migrated-key mechanism, registry line 35, already establishes this pattern).
- Plugin providers register **asynchronously** after plugin load; built-ins are available at DI time. Unifying must not make built-ins async (tasks referencing a provider before registration would degrade).
- Provider effects use `LOCAL_ACTIONS` (sync rule 1); refactors must not change dispatch behavior or op-log semantics. Phases below intentionally avoid touching state shape.

### Proposed direction

Do **not** force built-ins to become plugins. Instead:

1. **One registry, two registration sources.** Introduce a unified `IssueProviderRegistryService` keyed by `IssueProviderKey`, holding `{ key, service: IssueServiceInterface, icon, humanizedName, issueStrings, pollIntervalMs, defaultCfg?, formCfg?, contentCfg?, source: 'built-in' | 'plugin' }`. Built-ins register synchronously via an `ISSUE_PROVIDER` multi-provider `InjectionToken`; the plugin registry forwards its registrations into the same service. All `hasProvider ? registry : constMap` branches collapse to a single lookup.
2. **Shared HTTP kit (opt-in)** for built-in API services: an `IssueProviderHttpService` providing request plumbing with a per-provider auth-header strategy and unified error normalization, superseding the per-provider `_sendRequest$`/`_checkSettings` copies and the three divergent error-handling styles. Modeled on the existing `PluginHttpService` + `handleIssueProviderHttpError$`.
3. **Pluginize only where the API already suffices** (Azure DevOps is the single near-fit candidate: no effects, no custom view components, declarative content config, plain Basic-auth REST). Treat as an optional follow-up experiment, not the goal.

### Acceptance criteria

- [ ] `IssueService` contains no `ISSUE_SERVICE_MAP` and no `_pluginRegistry.hasProvider(...)` conditionals; provider dispatch is one registry lookup.
- [ ] Icon, humanized name, issue strings, poll interval, form cfg, content cfg, and default cfg for built-ins are resolved through the same registry API used for plugin providers (const maps in `issue.const.ts` either deleted or reduced to data fed into registration).
- [ ] Adding a new built-in provider requires only: provider folder + one registration entry (no edits to `issue.service.ts`, `issue.const.ts` maps, icon pipe, or content component dispatch).
- [ ] Non-Jira built-in API services share one HTTP/error-handling helper; user-visible error snacks remain equivalent (covered by specs).
- [ ] No change to persisted `IssueProvider` state shape, provider keys, or op-log behavior; all existing unit tests and issue-related E2E pass.
- [ ] Documented capability-gap list for the plugin API (attachments, subtasks, custom dialogs/effects, custom cfg components, Electron IPC) so future "move provider to plugin" decisions are explicit.

## Implementation plan

Pilot provider: **Redmine** — smallest common-interfaces service (85 LOC), single-file API service (402 LOC) with the cleanest `_sendRequest$` copy, simple header auth (`X-Redmine-API-Key`), existing spec coverage (`redmine-api.service.spec.ts`), and no custom view components (its one effect, time posting, is unaffected by registry/HTTP changes). Jira is explicitly the *last* provider for the HTTP phase (Electron IPC, OAuth, pagination) and Calendar/ICAL is last for registry edge cases (virtual provider, no HTTP).

### Phase 1 — Unified registry skeleton + pilot (M)

Independently shippable: registry exists, Redmine registers through it, everything else keeps working via fallback.

- New: `src/app/features/issue/registry/issue-provider-registry.service.ts` + `issue-provider-registration.model.ts` + `ISSUE_PROVIDER` multi `InjectionToken`; registry spec.
- `PluginIssueProviderRegistryService.register/unregister` forwards into the unified registry (plugin entries carry `source: 'plugin'`); keep the plugin-specific accessors (`getConfigFields`, `getFieldMappings`, `getCommentsConfig`) where they are for now.
- `RedmineCommonInterfacesService` registers itself (key, service, icon `redmine`, name, poll interval, `DEFAULT_REDMINE_CFG`, `REDMINE_CONFIG_FORM_SECTION`, content config) — data moves from `issue.const.ts` maps into the registration.
- `IssueService._getService` and the four metadata helpers (`issue.service.ts:821-860`) consult the unified registry first, then fall back to existing maps.
- Tests: new registry spec; extend `issue.service.spec.ts` to cover built-in-via-registry dispatch (Redmine) and untouched fallback (e.g. Jira).
- Risk check: registration happens in DI providers at bootstrap → no async gap for built-ins; no state/effects changes.

### Phase 2 — Migrate remaining 8 built-ins, delete dual paths (M)

Mechanical but wide; shippable as one PR or two (providers, then consumers).

- Register GitLab, Jira, OpenProject, Trello, Azure DevOps, Nextcloud Deck, CalDAV, Calendar.
- Delete `ISSUE_SERVICE_MAP` and the 9 injected common-interfaces services from `issue.service.ts`; collapse `_getService`/`_getProviderIcon`/`_getProviderName`/`_getIssueStrings`/`_getPollInterval` to single registry lookups.
- Replace const-map reads + `hasProvider` branches in: `issue-icon.pipe.ts`, `issue-content.component.ts` (unify `IssueContentConfig` resolution — built-in `ISSUE_CONTENT_CONFIGS` and plugin `issueDisplay` already converge on the same model in the component's `config` computed), `issue-header.component.ts`, `issue-panel.component.ts`, `issue-provider-setup-overview.component.ts`, `dialog-edit-issue-provider.component.ts` (form-cfg/default-cfg resolution only; leave plugin-OAuth specifics), `poll-to-backlog.effects.ts`, `tag-list.component.ts`.
- Keep `issue.const.ts` type constants (`JIRA_TYPE` etc.) — they're persisted-key anchors; only the five metadata maps dissolve into registrations (or remain as the data source the registrations import from, then shrink).
- Tests: existing specs for pipe/components; `npm run e2e` for one provider flow; verify no behavior change in snack texts.
- Risk: this touches `poll-to-backlog.effects.ts` (uses `LOCAL_ACTIONS` — keep action wiring untouched, only metadata lookup changes).

### Phase 3 — Shared HTTP/error kit for built-in API services (M)

Shippable per provider; pilot Redmine first.

- New: `src/app/features/issue/base/issue-provider-http.service.ts` (or extend `base/`): generic `request$` with auth-header strategy function, sent-event filtering, body unwrapping, settings validation hook, and error normalization that routes through `handle-issue-provider-http-error.ts` consistently. Borrow the plugin adapter's 404/410 remote-deletion detection so built-ins gain it too (behavior change — flag in PR).
- Migrate in order: Redmine (delete `_sendRequest$`, `_checkSettings`; ~80 LOC removed), OpenProject, GitLab, Trello, Azure DevOps, Nextcloud Deck. Jira excluded (Electron IPC path stays; optionally adopt only the error normalizer). CalDAV/ICAL excluded (no plain HTTP / no HTTP).
- Tests: per-provider api.service specs updated; add shared-kit spec covering auth strategies and error mapping.
- Estimate: S per provider after the kit lands; kit itself M.

### Phase 4 (optional, exploratory) — Pluginize Azure DevOps; document the gap list (L)

Only worth doing if maintainers want fewer in-tree providers; otherwise close with Phase 3.

- Port `azure-devops` to `packages/plugin-dev/azure-devops-issue-provider` using the migrated-key mechanism (`issueProviderKey: 'AZURE_DEVOPS'`, auto-enable list in `plugin.service.ts:69-71`), following the gitea plugin (371 LOC single file) as template.
- Requires a config migration: built-in cfg fields → `pluginConfig` shape on existing `IssueProvider` entities. **This touches synced state** — needs a model-version migration and careful review against sync rules (replay determinism, `SYNC_IMPORT`); call out explicitly in the PR.
- Deliverable either way: a doc section listing plugin-API gaps (attachments, subtasks, custom dialogs/effects, custom cfg components, Electron IPC, deep calendar integration) as the criteria for future built-in vs plugin decisions.
- Recommendation: defer; Phases 1-3 already deliver one registry path and shared utilities without state migrations.

## Verification notes

- **Confirmed:** 9 in-tree providers under `src/app/features/issue/providers/` (the ninth, "iCal", is the `calendar/` folder, key `ICAL`). `issue.service.ts` = 906 LOC with hardcoded `ISSUE_SERVICE_MAP` (line 98). `jira-api.service.ts` = 1,011 LOC. `PluginIssueProviderAdapterService` = 628 LOC, `PluginIssueProviderRegistryService` = 131 LOC. Two parallel mechanisms confirmed, with the dual-path `hasProvider ? plugin : builtin` branch replicated across ~10 consumer files (33 files reference the plugin registry/adapter).
- **Corrected:** "Gitea, Linear were moved out to plugins" — undersells it: **GitHub and ClickUp** were also migrated (`plugin.service.ts:47-60`, auto-enabled at `:160-177`), and CalDAV-calendar/Google-calendar plugins exist too. The migrated-key mechanism (`'GITHUB'` instead of `plugin:*`) already proves stable-key pluginization.
- **Corrected:** "Each reimplements *-common-interfaces.service.ts" — stale. All 9 built-ins extend `BaseIssueProviderService` (`src/app/features/issue/base/base-issue-provider.service.ts`), which already shares getById/search/fresh-data logic; per-provider services are 85-110 LOC and mostly genuinely provider-specific. The per-provider cfg-form consts, content consts, models, and (for 5 providers) issue-map utils do exist as claimed.
- **Corrected/characterized:** "high duplication across auth/pagination/error-handling/retry/mapping" — partially holds. Real: near-identical `_sendRequest$` + settings-check plumbing in Jira/Redmine/OpenProject (~60-100 LOC each) and *inconsistent* (three styles) rather than merely duplicated error handling; hand-rolled auth headers everywhere. Not real: pagination duplication (only Jira paginates, `jira-api.service.ts:399-481`) and retry logic (none exists). No percentage figure is defensible; dropped.
- **Verified plugin-API gaps** vs `IssueServiceInterface`: no attachments (`getMappedAttachments` — Jira/Trello), no subtasks (`getSubTasks` — CalDAV), no custom dialogs/effects (Jira/OpenProject transitions + worklogs, Redmine time posting, GitLab worklog dialog), no custom cfg components (Jira/OpenProject/Trello/Nextcloud Deck), no Electron IPC HTTP (Jira). Worklogs/transitions live in per-provider *effects*, not in `IssueServiceInterface` itself; `updateIssueFromTask` is declared in the interface but implemented by no built-in (two-way sync goes through the separate `IssueSyncAdapter` registry, which is *also* dual-path: built-in CalDAV adapter + generated plugin adapters via `issue-sync-adapter-resolver.service.ts`).
- **Verified registry-first dispatch already exists** in `IssueService._getService` (`issue.service.ts:821-828`) — the unification proposed here finishes an in-progress direction rather than starting a new one, which lowers the risk of the plan.
