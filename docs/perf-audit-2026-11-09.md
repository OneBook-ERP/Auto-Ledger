# Performance audit, 9 Nov 2026

Task P1 of the wave 3 plan. Measured on the Oppo CPH2487 over wireless debugging, on the **dev build** (Metro, debug Hermes), so absolute numbers are worse than a release build. Use the relative comparisons. Inbox had **438 pending rows** (Home banner and Inbox header agree) and 5 drafts. No real transaction was answered, created or undone; no screen with a write button was used. Screen content is described generically.

## What was measured, and what was not

| Screen | Result (dev build) |
|---|---|
| Cold start (`am start -W`, after force-stop) | 1.34 to 1.45 s. This is only the dev launcher activity: the JS bundle is loaded from Metro afterwards (about 10 s until Home was on screen, polled every 2 s, so coarse). A release cold start is not measurable here. |
| Home | idle PSS about 837 MB. Scrolling: 83 frames, 0 janky, p50 7 ms, p99 13 ms. Smooth. |
| Inbox, opening (438 rows) | 108 frames, 1 janky (10 on the legacy 16.7 ms rule), p95 24 ms, **p99 150 ms** (one long frame when the 438 rows mount). PSS 894 MB, about +56 MB over Home. |
| Inbox, scrolling 8 slow swipes | 330 frames, p50 **20 ms**, p90 24 ms, p99 30 ms; 81% of frames miss 16.7 ms (about 50 fps), GPU only 2 to 3 ms, so the cost is on the UI/JS side, not drawing. Home in the same session: p50 7 ms. |
| Inbox, 15 then 30 fast flings | p50 20 ms, p99 29 to 34 ms, 1.7% janky (new rule), 75% legacy. Never recovers to Home's 7 ms. |
| Memory across Inbox visits | PSS 894 (open) then 840, 845, 863 MB after scrolling: no steady growth within the session (GC returns it). Java heap 58 to 76 MB, native heap 513 to 543 MB. One earlier run (before the dev client was reconnected, state not fully known) showed native heap going from 12 to 163 MB after 12 swipes in the Inbox; not reproduced, treat as unconfirmed. |
| Activity, opening | 64 frames, 10 janky (15.6%), p95 105 ms, p99 200 ms. A second run: 11 frames, 1 janky. PSS 881 MB. |

**Not measured, and why**
- Transaction detail, each answer step and Confirm: opening them would have required tapping an unanswered real transaction (risk of writing to ERPNext), and the app lost its JS runtime (see below) before I could do the read-only detail open. Code-read only.
- Settings and Activity scrolling: the app dropped to a blank grey screen with "Tried to enqueue runnable on already finished thread" in logcat during my Activity scroll (no crash entry, process still alive). I could not tell whether it was the dev client reloading or the app; it needs a person at the phone. After that, taps landed on the launcher and the notification shade, so later numbers were discarded.
- True time to first content per screen: gfxinfo gives frame cost, not time to first content. No screen recording was taken. Release-build numbers: not available (dev client only).
- Memory "before and after each screen" exists only for Home, Inbox and Activity open.

## Ranked findings

Ranking is by what the user feels with 438 rows today, and by what an all-time SMS scan (2,000+ rows) multiplies.

### 1. Inbox renders every pending row at once in a plain ScrollView (owner: I)
- Evidence: p50 20 ms and about 50 fps while scrolling the Inbox versus 7 ms on Home; GPU 2 to 3 ms, so it is the size of the view tree; p99 150 ms when opening; 438 rows today, each about 10 native views (Pressable, 3 Views, 3 Texts, two SVG icons, a Pill), so roughly 4,000 views, and it scales linearly with the SMS window.
- Cause: `app/(tabs)/inbox.tsx:69-79` maps all sections and rows into a `ScrollView` (`src/ui/RefreshScroll.tsx:7`); no `FlatList`/`SectionList` is used anywhere in the app.
- Fix: virtualised list with paging of 50 (Task I3: `FlatList`/`SectionList`, fixed row height and `getItemLayout`, `React.memo` rows, `keyExtractor` = id). Expected: first mount and scroll cost bounded by the window, independent of N; p50 back near Home's 7 to 10 ms.

### 2. Every row is fully built on every reload, including the suggestion (owner: I)
- Evidence: model build is O(N rows x rules); runs on every focus and every refresh and every answer.
- Cause: `src/inbox/model.ts:63-81` `toRow` calls `resolveMapping` (`src/ingest/pipeline.ts:104-108`, filters all mappings per row) and `suggest()` (`src/core/suggest.ts:61`, loops all rules, normalises keys) for all rows, shown or not. `src/inbox/hooks.ts:21-37` `reload()` rebuilds the whole model and calls `setModel`, so one answered item re-renders and re-suggests all rows. `newestFirst` (`model.ts:52`) also copies and sorts the full list on each reload.
- Fix: build lightweight rows (title, amount, subtitle) first and compute `chipFor`/`suggest` lazily for visible rows, memoised by txn id and rules version (Task I3). Filter before building (Task I2). Expected: model build for 3,000 rows well under 300 ms, and an answer no longer rebuilds the other rows.

### 3. A tab-bar poll loads and parses every pending row just to show a count, forever (owner: not in any workstream: `app/(tabs)/_layout.tsx`)
- Evidence: runs on every tab and screen, every 15 s, while the app is open.
- Cause: `app/(tabs)/_layout.tsx:23` `repo.listPending('new').then((l) => setN(l.length))`. `listPending` (`src/data/repo.ts:141-146`) selects 20 columns for all matching rows and runs `toPending` including `JSON.parse` of `created_docs` (`repo.ts:68-70`) for each. At 438 rows this is wasted work on the same JS thread that scrolls; at 3,000 it is a visible hitch every 15 s.
- Fix: add `repo.countPending(state)` (`SELECT COUNT(*) ... WHERE state = ?`, uses `idx_pending_state`, `src/data/schema.ts:61`) and use it here. Needs a file outside the three workstreams: ask the controller. Expected: constant, sub-millisecond.

### 4. The Inbox loads all "created" drafts in full only to count them (owner: I)
- Cause: `src/inbox/hooks.ts:23` `repo.listPending('created')` then `created.length` at `hooks.ts:33`; every created row is mapped with a JSON parse. It grows with every answered transaction, not just pending ones.
- Fix: the same `countPending('created')` as finding 3. Expected: removes one of the two full-table reads per Inbox reload.

### 5. Home and Activity load every transaction in every state (owner: not in a workstream: `src/home/useHome.ts:95`, `app/(tabs)/activity.tsx:55`)
- Evidence: Activity open had 15.6% janky frames, p99 200 ms in the first run.
- Cause: `useHome.ts:95` and `activity.tsx:55` call `repo.listPending()` with no state, so all rows, including the 438 unanswered ones, are read, parsed and held in React state on every focus/refresh (`staleTime: 0` at `useHome.ts:92`). `src/home/viewModel.ts:133` also runs `resolveMapping` over all pending rows once per bank account (O(accounts x N)). `activity.tsx:205-213` re-filters and re-sorts all items on every render (including each keystroke of search).
- Fix: query only `created/submitted/ignored` for Activity and only the aggregates Home needs (counts and the latest balance per account via SQL); memoise the Activity derivation with `useMemo`; keep the "Show older" paging, which already limits rows drawn. Expected: Activity open work independent of the number of unanswered messages.

### 6. A full-list `useColorScheme` hook and a new `onPress` closure per row (owner: I, `src/ui/TxnRow.tsx`)
- Cause: `TxnRow.tsx:27` calls `useColorScheme()` in each of N rows, and `app/(tabs)/inbox.tsx:74` creates a new closure per row per render, so wrapping the row in `React.memo` would not help until the handler is stable.
- Fix: pass `onPress` with the id (stable callback) and `React.memo(TxnRow)`; read the colour scheme once per list or use the NativeWind `dark:` classes only. Small gain alone, needed for finding 1 to pay off.

### 7. Duplicate-warning lookups must not be per row (owner: D, preventive)
- Not measured (feature not built). Risk: a per-row ERPNext query or a per-row scan in `src/ingest/dupCheck.ts` would make findings 1 and 2 worse. Do the check once per cycle in batch (one list call per date range, one index by amount+date) and store the flag on the row; never inside list rendering or `reload()`.

### 8. All-time SMS scan makes everything above scale (owner: W, preventive)
- With "All time", N pending rows can reach thousands. `src/ingest/pipeline.ts` upserts per message; check that the backfill writes in batches inside a transaction, yields to the UI between batches, and does not trigger an Inbox `reload()` per message. Not measured.

## Suggested order for wave 3a
1. I: Task I3 (findings 1, 2, 4, 6) with the model tests already planned; re-measure on the phone with the same method (Inbox open p99, scroll p50 versus 20 ms baseline above).
2. Controller: approve a small change for findings 3 and 5 (`countPending`, state-scoped Activity query), which are outside the three workstreams.
3. D and W: findings 7 and 8 as constraints in review.

## Method (to repeat the baseline)
`adb -s <serial> shell dumpsys gfxinfo app.onebook.autoledger reset`, tap the tab, wait 3 to 4 s, then `dumpsys gfxinfo app.onebook.autoledger` for the frame counts and percentiles; `dumpsys meminfo app.onebook.autoledger` for PSS and heaps. Scrolling: `input swipe 600 2200 600 700 250` repeated 8 times with 0.25 s pauses. Dev client note: after a force-stop the launcher must be told to open the Metro server (tap the listed development server), no credentials needed.
