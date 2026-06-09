# RRULE Epic — Roadmap & Branch Model

In-tree mirror of the epic tracker for the RFC 5545 RRULE recurring-schedules
overhaul. The canonical, watchable tracker is the **standing draft PR
`feat/rrule-epic → master`**; this doc travels with the branch and is the source of
truth for the phase list, branch names, and the issue/branch wiring.

Companions: [`recurring-events-implementation-plan.md`](recurring-events-implementation-plan.md)
(the plan) · [`rrule-epic-review-watchlist.md`](rrule-epic-review-watchlist.md)
(per-phase risk checklist).

---

## Branch model

- **Epic = the standing PR `feat/rrule-epic → master`.** Long-running, opened as a
  draft; its body holds the phase table. Merges to master only once the epic is whole
  and testable in final form. Opened/owned by the maintainer (it heads from the
  upstream `feat/rrule-epic` branch).
- **Integration branch = `feat/rrule-epic`** (upstream). Phases merge into it; it is
  never rebased onto master mid-epic.
- **Phase branches = `feat/rrule-epic-pN-<slug>`** — a **hyphen**, not a slash.
  > A git ref cannot be both a branch and a directory. While `feat/rrule-epic` exists
  > as a branch, `feat/rrule-epic/<phase>` is rejected:
  > `fatal: cannot lock ref … 'feat/rrule-epic' exists; cannot create
'feat/rrule-epic/p2-heatmap'`. GitHub enforces the same. The hyphen scheme keeps
  > the visual grouping (phases sort adjacent to the epic branch) with no conflict.
- **Reference / waypoint = `feat/recurring-full`** (currently fork-side, `omega-tree`):
  the full implementation. Each phase is a reviewable slice cut from it.
- **Off-by-default per-device flag** (`RRuleFeatureFlagService`, localStorage, never
  synced) keeps the legacy `repeatCycle` engine authoritative while off — so the branch
  can hold half-built phases (and eventually sit in master) with no half-state risk.

### Contribution flow (fork-based — no upstream push access)

Work happens on the fork (`omega-tree/super-productivity`) and lands via PRs:

1. Cut a phase branch from the waypoint: `feat/rrule-epic-pN-<slug>` (on the fork).
2. PR it into upstream **`feat/rrule-epic`**, body `Part of #<epic-PR>` (never `Closes` —
   that would auto-close the epic on a phase merge).
3. On merge, tick the phase's row.
4. The standing `feat/rrule-epic → master` PR is the **only** one that `Closes`
   (the epic · #4020 · #7239) — and only when the whole epic lands.

> **Pending now:** `origin/feat/rrule-epic` (`1df014090`) does not yet contain the
> Phase-1 follow-ups + flag — those sit on `fork:feat/rrule-epic` (`37d797a9a`, +5
> commits). First action is a PR `fork:feat/rrule-epic → origin:feat/rrule-epic` to put
> them on the integration branch.

### Issue wiring

- **#4020** "Enhanced Repeating Schedule" — **must be reopened**: it was auto-closed by
  the #7948 squash-merge (`1718b0a8b`), which was then reverted from master
  (`3d2c811e7`), so the feature is _not shipped_. The standing master PR re-closes it.
- **#4931** "Collection: Repeat Task / Recurring Task Improvement" (open) — parent
  collection; the epic links under it (`Part of #4931`).
- **#7239** "Local REST API should support creating recurring tasks" (open) — closed by
  Phase 7.

---

## Phases

Each phase = a PR `feat/rrule-epic-pN-<slug> → feat/rrule-epic`, body `Part of` the epic
PR (never `Closes`).

- [x] **1 — Core** · `feat/rrule-epic` — RFC 5545 occurrence engine (UTC/local-noon,
      DST-safe, fail-soft), structured RRULE builder, legacy⇄RRULE migration (both
      directions), live text preview, quick-setting presets, forward-compat clamp,
      property/invariant/fuzz tests, off-by-default per-device flag, follow-ups
      (from-completion flip, `isRRuleValid` never-fire/freeze, deterministic
      `_parseStart`, rrule re-anchor test). _✅ on branch — follow-ups: fork→origin
      PR pending._
- [ ] **2 — Heatmap + simulation** · `feat/rrule-epic-p2-heatmap` — 365-day occurrence
      heatmap; click a day to simulate completing it and re-anchor. _⏸ on waypoint._
- [ ] **3 — Natural language `@+`** · `feat/rrule-epic-p3-nl` — `@+<phrase>` → RRULE +
      add-task-bar wiring + humanized "rule · next date" preview. _⏸ on waypoint._
- [ ] **4 — Due-date derivation** · `feat/rrule-epic-p4-duetype` — per-instance Due =
      appears + offset / until-next / period-end / fixed / from-completion / none.
      _⏸ on waypoint._
- [ ] **5 — Ends after N completions** · `feat/rrule-epic-p5-endsafter` — stop after N
      completed instances (needs min-client-version gate — old clients ignore the field);
      rejects `COUNT`+completion at the persist boundary. _⏸ on waypoint._
- [ ] **6 — Missed-occurrence backfill** · `feat/rrule-epic-p6-backfill` — a task per
      missed occurrence (+ build-set-once perf). _⏸ on waypoint._
- [ ] **7 — REST API recurring** · `feat/rrule-epic-p7-rest` — create recurring tasks
      over the local REST API (rrule/startDate/from-completion) — #7239; adds
      persist-boundary guards for untrusted ingestion (unsupported-FREQ / `repeatCycle`
      wire-safety — defends the non-dialog write path). _⏸ on waypoint._
- [ ] **8 — RECURRENCE-ID overrides** · `feat/rrule-epic-p8-overrides` — edit a single
      occurrence (move / re-time / re-title) via RDATE+EXDATE. _⏸ on waypoint._
- [ ] **9 — iCal / RRULE export** · `feat/rrule-epic-p9-ical` — export recurrences as
      `.ics` / RRULE strings. _⬜ not built._
- [ ] **10 — Adaptive scheduling** · `feat/rrule-epic-p10-adaptive` — learn completion
      cadence (exp-decay weighted avg of historical delays) → suggest / auto-adjust the
      next due; opt-in per repeat cfg. Op-log-deterministic (from recorded completions,
      not wall-clock). _🔭 not built._
- [ ] **11 — Trigger-based recurrence** · `feat/rrule-epic-p11-trigger` — next occurrence
      fires on an event / state-change condition instead of a clock. _🔭 not built._
- [ ] **12 — Sub-daily / hourly** · `feat/rrule-epic-p12-subdaily` — interval-hours +
      multiple-per-day (`FREQ=HOURLY`/`BYHOUR`); revisits the local-noon/DST model —
      largest of the four. Owns the engine + persist-boundary sub-daily handling; until
      then sub-daily is rejected at save **and the persist boundary**. _🔭 not built._
- [ ] **13 — Multiple reminders per occurrence** · `feat/rrule-epic-p13-reminders` — more
      than one reminder offset per recurring instance. _🔭 not built._

Status key: ✅ done · ⏸ implemented on the waypoint, awaiting its slice · ⬜ not started ·
🔭 newly scoped, not built. Donetick assignee rotation / round-robin is intentionally out
of scope — SP recurrence is single-assignee.

---

## Feature comparison (RFC 5545 baseline, expanded)

**SP now** = released Super Productivity (master, legacy repeat). **SP this epic** = after
the epic lands. `*Google` = Google **Calendar** (RRULE-complete via API/import; the
custom-recurrence GUI is limited; Google **Tasks** is far weaker). **Donetick** =
open-source self-hosted chore manager (closest OSS peer). **Build** = status on the SP
waypoint: ✓ built · ☐ planned · — not planned. Markers: ✅ full · ➖ partial/limited ·
❌ none · 🟢 SP-distinct.

| Feature                                | SP now | RFC 5545 | SP this epic | Google\* | Todoist | Things 3 | TickTick | Donetick | Build          |
| -------------------------------------- | ------ | -------- | ------------ | -------- | ------- | -------- | -------- | -------- | -------------- |
| **— Frequency —**                      |        |          |              |          |         |          |          |          |                |
| Basic D/W/M/Y                          | ✅     | ✅       | ✅           | ✅       | ✅      | ✅       | ✅       | ✅       | ✓              |
| Every N interval                       | ✅     | ✅       | ✅           | ✅       | ✅      | ✅       | ✅       | ✅       | ✓              |
| Weekday selection                      | ✅     | ✅       | ✅           | ✅       | ✅      | ✅       | ➖       | ✅       | ✓              |
| Nth weekday of month (`2TU`)           | ✅     | ✅       | ✅           | ✅       | ✅      | ✅       | ❌       | ✅       | ✓              |
| 🟢 Per-day ordinals (`3MO,4SU`)        | ❌     | ✅       | ✅           | ➖       | ❌      | ❌       | ❌       | ➖       | ✓              |
| Last day / last weekday                | ✅     | ✅       | ✅           | ✅       | ➖      | ➖       | ❌       | ➖       | ✓              |
| Last business day (`BYSETPOS=-1`)      | ❌     | ✅       | ✅           | ➖       | ➖      | ❌       | ❌       | ❌       | ✓              |
| Multiple month-days (`1,15`)           | ❌     | ✅       | ✅           | ➖       | ❌      | ➖       | ❌       | ➖       | ✓              |
| Seasonal `BYMONTH`                     | ❌     | ✅       | ✅           | ➖       | ❌      | ❌       | ❌       | ➖       | ✓              |
| 🟢 `BYWEEKNO`/`BYYEARDAY`/`WKST`       | ❌     | ✅       | ✅           | ➖       | ➖      | ❌       | ❌       | ❌       | ✓              |
| **— End conditions —**                 |        |          |              |          |         |          |          |          |                |
| Never                                  | ✅     | ✅       | ✅           | ✅       | ✅      | ✅       | ✅       | ✅       | ✓              |
| On date (`UNTIL`)                      | ❌     | ✅       | ✅           | ✅       | ✅      | ✅       | ✅       | ❌       | ✓              |
| After N occurrences (`COUNT`)          | ❌     | ✅       | ✅           | ✅       | ❌      | ✅       | ✅       | ❌       | ✓              |
| End after N completions                | ❌     | ➖       | ✅           | ❌       | ❌      | ➖       | ➖       | ❌       | ✓ Ph5          |
| **— Occurrence control —**             |        |          |              |          |         |          |          |          |                |
| Skip / exclude one (`EXDATE`)          | ✅     | ✅       | ✅           | ✅       | ➖      | ❌       | ✅       | ❌       | ✓              |
| Edit one occurrence (`RECURRENCE-ID`)  | ❌     | ✅       | ✅           | ✅       | ➖      | ❌       | ✅       | ❌       | ✓ Ph8          |
| **— Completion-relative —**            |        |          |              |          |         |          |          |          |                |
| After-completion scheduling            | ✅     | ❌       | ✅           | ❌       | ✅      | ✅       | ✅       | ✅       | ✓              |
| Configurable gap after completion      | ✅     | ❌       | ✅           | ❌       | ➖      | ✅       | ✅       | ✅       | ✓              |
| Wait-for-completion (no pile-up)       | ✅     | ❌       | ✅           | ❌       | ➖      | ✅       | ➖       | ✅       | ✓              |
| Adaptive (learns cadence)              | ❌     | ❌       | ✅           | ❌       | ❌      | ❌       | ❌       | ✅       | ☐ Ph10         |
| Trigger-based (state-change fires)     | ❌     | ❌       | ✅           | ❌       | ❌      | ❌       | ❌       | ✅       | ☐ Ph11         |
| **— Time / reminders —**               |        |          |              |          |         |          |          |          |                |
| Specific time-of-day                   | ✅     | ✅       | ✅           | ✅       | ✅      | ➖       | ✅       | ✅       | ✓              |
| Hourly / sub-daily / multi-per-day     | ❌     | ✅       | ✅           | ✅       | ✅      | ❌       | ❌       | ✅       | ☐ Ph12         |
| Reminder lead-time per occurrence      | ✅     | ➖       | ✅           | ➖       | ✅      | ✅       | ✅       | ✅       | ✓              |
| Multiple reminders per occurrence      | ❌     | ➖       | ✅           | ➖       | ❌      | ➖       | ✅       | ✅       | ☐ Ph13         |
| **— Entry —**                          |        |          |              |          |         |          |          |          |                |
| Natural-language entry                 | ❌     | ➖       | ✅           | ➖       | ✅      | ➖       | ✅       | ✅       | ✓ Ph3          |
| 🟢 `@+` NL → RRULE + next-date preview | ❌     | ❌       | ✅           | ❌       | ➖      | ❌       | ➖       | ❌       | ✓ Ph3          |
| 🟢 Raw RRULE override (UI)             | ❌     | ✅       | ✅           | ❌       | ❌      | ❌       | ➖       | ❌       | ✓              |
| **— Preview —**                        |        |          |              |          |         |          |          |          |                |
| Occurrence list / calendar preview     | ❌     | ➖       | ✅           | ➖       | ➖      | ❌       | ✅       | ❌       | ✓              |
| 🟢 Heatmap occurrence preview          | ❌     | ➖       | ✅           | ❌       | ❌      | ❌       | ❌       | ❌       | ✓ Ph2          |
| 🟢 Completion **simulation** preview   | ❌     | ❌       | ✅           | ❌       | ❌      | ❌       | ❌       | ❌       | ✓ Ph2          |
| **— Derivation / backfill —**          |        |          |              |          |         |          |          |          |                |
| 🟢 Per-instance due-date derivation    | ❌     | ➖       | ✅           | ❌       | ➖      | ❌       | ➖       | ❌       | ✓ Ph4          |
| 🟢 Create task per missed occurrence   | ❌     | ➖       | ✅           | ❌       | ❌      | ❌       | ❌       | ❌       | ✓ Ph6          |
| **— Teams / projects / habits —**      |        |          |              |          |         |          |          |          |                |
| Assignee rotation / round-robin        | ❌     | ❌       | ❌           | ❌       | ❌      | ❌       | ❌       | ✅       | — out of scope |
| Repeating projects w/ checklist        | ❌     | ❌       | ❌           | ❌       | ❌      | ✅       | ❌       | ➖       | —              |
| Habit-tracking subsystem               | ❌     | ❌       | ❌           | ❌       | ❌      | ❌       | ✅       | ❌       | —              |
| **— Interop —**                        |        |          |              |          |         |          |          |          |                |
| iCal / RRULE export                    | ❌     | ✅       | ✅           | ✅       | ✅      | ❌       | ✅       | ❌       | ☐ Ph9          |
| iCal / RRULE import                    | ➖     | ✅       | ➖           | ✅       | ❌      | ➖       | ➖       | ❌       | ✓              |
| REST / API create recurring            | ❌     | ➖       | ✅           | ✅       | ✅      | ❌       | ✅       | ✅       | ✓ Ph7          |

### 🟢 Genuinely SP-distinct (no mainstream rival matches)

- **Completion simulation** preview — click a day, the series re-anchors. _Nobody else._
- **Create a task per missed occurrence** — true catch-up, not just "next". _Nobody else._
- **Heatmap** 365-day occurrence preview. _Nobody else._
- **Per-day ordinals** (`3MO,4SU`), **seasonal `BYMONTH`**, **`BYWEEKNO`/`BYYEARDAY`/`WKST`**,
  **raw RRULE override** in the _UI_ — Google only via API/import; mainstream apps not at all.
- **Per-instance due-date derivation** (due = appears + offset / until-next / period-end /
  fixed / from-completion / none).

---

## Forward-compat note (carries every phase)

New `quickSetting` literals (incl. `RRULE`) are never persisted — saved cfgs use a
`master`-safe value (`CUSTOM`); the rich value drives the dialog UI in-memory only, so
typia on old/mobile clients stays happy. Engine internals stay UTC; the opaque `rrule`
string keeps `repeatCycle` within the old enum subset, so old clients ignore unknown
fields and fall back to the legacy schedule. Each deferred / new phase carries its own
sync surface — re-run the [watchlist](rrule-epic-review-watchlist.md) "Always-verify" list.
