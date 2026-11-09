# Wave 3: fast Inbox, duplicate warnings, smart classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Inbox fast and searchable, warn when an SMS looks like something already booked in ERPNext, let the user read all-time SMS history, and add an auto-classifier with grouped bulk answers that becomes automatic for patterns the user has confirmed.

**Architecture:** Wave 3a runs four independent workstreams in parallel worktrees (P perf audit, I inbox, W window, D duplicate warning). Wave 3b (K classifier) starts after I and D merge, because it changes the Inbox rows and needs the duplicate flag. Pure logic goes in `src/core`; screens stay thin.

**Tech Stack:** Expo SDK 58, React Native 0.88, TypeScript, Expo Router, NativeWind v4, expo-sqlite, Jest + React Native Testing Library, Kotlin module `modules/sms-ingest`.

**Spec:** `docs/superpowers/specs/2026-11-08-autoledger-design.md`, `docs/CONTEXT.md`, `docs/superpowers/plans/2026-11-09-wave2-accounting-fit-and-ui.md` (what exists now). Decisions from the user on 9 Nov 2026: possible duplicates are WARN ONLY (never blocked); the classifier does BOTH modes: the first time a pattern appears the app groups similar items and waits for the user, and after the user confirms it the same pattern is applied automatically from then on (the user can turn any rule off).

## Global Constraints

- Writes go ONLY to the stage site. Production (`atom.onebook.app`) is read-only and only when the user asks.
- Only DRAFTS (`docstatus` 0). Never submit. No Bank Transaction in this wave.
- Credentials only in git-ignored `.env.local`; never print, log or commit.
- Raw SMS text never leaves the device, is never persisted, never logged. Duplicate matching and grouping use parsed fields only.
- Money is integer minor units (paise) in `src/core`; no floats for amounts.
- Do not push to GitHub. Add files by name; never `git add -A` in a worktree. Do not edit `CLAUDE.md`.
- Copy: plain language for a non-accountant, sentence case, no em dashes, no jargon as primary text (no "UTR", "Debit/Credit", doctype names or document ids). Dates `8 Nov 2026`, true minus `−` for money out.
- Light AND dark themes from NativeWind tokens; touch targets at least 48 dp; icons only through `src/ui` (`Icon`).
- Strict TypeScript, 2-space indent, single quotes, semicolons, trailing commas. Commits `type(scope): summary` ending with the session's `Co-Authored-By` line.
- `npx tsc --noEmit` clean and the full Jest suite green before every commit that ends a task. Jest in a worktree uses a temp config outside the repo (see the ledger).

## Review Focus

- Inbox with 2,000+ pending items (an all-time scan): scrolling stays smooth, search and filters do not freeze the screen, memory does not grow with every filter change.
- A "possible duplicate" match against an ERPNext entry that is cancelled (`docstatus` 2) or belongs to a different company: must not warn.
- Two real, separate payments of the same amount to the same merchant on one day (two ₹500 fuel payments): the warning appears but nothing is hidden or blocked, and the app never auto-applies either of them.
- A bulk or automatic answer for one item fails halfway (offline, ERPNext error, closed period): the other items are not rolled back, the failed one stays in the Inbox with a plain message, and nothing is created twice when the user retries.
- A rule the user confirmed for "Facebook" must not fire for a different merchant whose normalised name merely contains it, for a foreign-currency charge (needs a rupee amount), for an amount far above past amounts, or for an item with a duplicate warning.
- Turning an automatic rule off, or editing its answer, must stop the next automatic run immediately and never touch drafts already created.

## File ownership (no two workstreams edit the same file)

| Workstream | Owns |
|---|---|
| P: perf audit (read-only on code) | new `docs/perf-audit-2026-11-09.md` only |
| I: Inbox speed, search, filters | `app/(tabs)/inbox.tsx`, `src/inbox/model.ts`(+test), `src/inbox/hooks.ts`, `src/state/activityModel.ts` (extract shared filter helpers only), new `src/inbox/inboxFilter.ts`(+test), `src/ui/TxnRow.tsx`, `src/ui/SearchField.tsx`, `src/ui/FilterSheet.tsx`, `src/ui/RefreshScroll.tsx`, `src/ui/index.ts` |
| W: all-time window | `src/ingest/pipeline.ts`(+test), `src/state/setup.ts`, `src/state/BackfillChoice.tsx`, `app/(setup)/permissions.tsx`, `app/(tabs)/settings.tsx`, `modules/sms-ingest/**`, `docs/play-sms-declaration.md`, `docs/CONTEXT.md` |
| D: duplicate warning | new `src/core/similar.ts`(+test), `src/erp/docs.ts`(+test), new `src/ingest/dupCheck.ts`(+test), `src/state/cycle.ts`, `app/txn/[id].tsx`, `src/inbox/describe.ts` |
| K: classifier (wave 3b) | new `src/core/classify.ts`(+test), `src/core/suggest.ts`, `src/core/types.ts`, `src/data/repo.ts`(+schema), `src/inbox/bulk.ts`(+test), new `app/txn/bulk.tsx`, new `app/(tabs)/rules.tsx` or a Settings section, `src/ingest/autoApply.ts`, and the Inbox files after I is merged |

If a task needs a file owned by another workstream, stop and tell the controller.

---

## Workstream P: performance audit (measurement first, on the phone)

The phone (Oppo CPH2487) is reachable through wireless debugging: use the serial shown by `adb devices -l` (it currently appears as `adb-423df194-c6pGEq._adb-tls-connect._tcp`). The app is `app.onebook.autoledger`. Do not install or uninstall anything and do not enter credentials: if the app is not usable without the user, say so.

### Task P1: Measure every screen

**Files:** Create `docs/perf-audit-2026-11-09.md`.

- [ ] **Step 1:** For Home, Inbox, Transaction detail, each answer step, Confirm, Activity, Settings and cold start, record: time to first content (from `adb shell am start -W` for cold start, and screen recordings or `dumpsys gfxinfo app.onebook.autoledger framestats` janky-frame percentage while scrolling and opening each screen), memory (`dumpsys meminfo app.onebook.autoledger` before and after visiting each screen), and the Inbox row count at the time.
- [ ] **Step 2:** Read the code of the slowest screens and name the cause with file and line (for example: every pending row rendered at once in `app/(tabs)/inbox.tsx`, `suggest()` computed for every row on every reload in `src/inbox/model.ts`, `listPending()` loading all states in `src/ingest/pipeline.ts`, queries inside loops).
- [ ] **Step 3:** Write a ranked list: finding, evidence (numbers), suggested fix, estimated effect. Mark which findings belong to Workstream I, W or D files.
- [ ] **Step 4: Commit** `docs: performance audit` (only that file).

---

## Workstream I: Inbox speed, search and filters

### Task I1: Shared pure filter helpers

**Files:** Create `src/inbox/inboxFilter.ts`; Test `src/inbox/inboxFilter.test.ts`; Modify `src/state/activityModel.ts` only to export the helpers both screens share.

**Interfaces:**
- Produces: `filterPending(items: PendingTxn[], f: {query: string; period: ActivityPeriod; direction?: 'in'|'out'; accountLast4?: string; kind?: 'bank'|'upi'|'card'}, today: string): PendingTxn[]` and `activeInboxFilterCount(f): number`. Reuses `ActivityPeriod`, `periodRange` and the search text logic from `activityModel.ts` (no RegExp built from user text).

- [ ] **Step 1: Write failing tests:** query matches merchant, counterparty and sender, case-insensitive, trimmed; `'('`, `'*'` and spaces-only do not throw; period boundaries as in Activity (financial year from 1 April); direction and account and kind filters combine with AND; the count counts only non-default settings.
- [ ] **Step 2: Run** `npx jest src/inbox/inboxFilter.test.ts`; fails.
- [ ] **Step 3: Implement** by extracting and reusing the Activity helpers.
- [ ] **Step 4: Run** the Activity and inbox tests and `npx tsc --noEmit`; pass.
- [ ] **Step 5: Commit** `feat(inbox): shared filter helpers`.

### Task I2: Search, period chips and filter sheet on the Inbox

**Files:** Modify `app/(tabs)/inbox.tsx`, `src/inbox/model.ts`, `src/inbox/hooks.ts`; Test `src/inbox/model.test.ts`, the Inbox screen test.

- [ ] **Step 1: Write failing tests:** typing "fuel" shows only matching rows; the "N to answer" count and the section titles follow the filtered rows; "Filters (n)" button opens the existing `FilterSheet` with direction, account and "How it was paid" (bank, UPI, card); Reset clears; the empty message when filters hide everything is "Nothing matches. Try a different search or period." and is different from the real empty Inbox message.
- [ ] **Step 2: Run** the Inbox tests; fail.
- [ ] **Step 3: Implement** reusing `SearchField`, `Chip` and `FilterSheet`; filtering happens on the loaded items before `buildInboxModel` builds rows, so suggestions are computed only for rows that are shown.
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(inbox): search, period chips and filters`.

### Task I3: Fast list (virtualised, suggestions on demand)

**Files:** Modify `app/(tabs)/inbox.tsx`, `src/inbox/model.ts`, `src/ui/RefreshScroll.tsx`, `src/ui/TxnRow.tsx`; Test `src/inbox/model.test.ts`, a list test.

**Interfaces:**
- Produces: `buildInboxModel` returns lightweight rows first; `chipFor`/`suggest` run per visible row (memoised by txn id and rules version), not for all rows at once.

- [ ] **Step 1: Write failing tests:** with 3,000 pending items the model builds in under 300 ms in Jest (use a fixed budget) and only the first page of rows is rendered (assert the number of rendered `TxnRow`s is at most the page size plus a window); scrolling to the end loads the next page; `reload()` after answering one item does not rebuild suggestions for the others (assert `suggest` call count).
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement** with `FlatList`/`SectionList` (`getItemLayout` with the fixed row height, `initialNumToRender`, `windowSize`, `keyExtractor` = id), `React.memo` rows, paging of 50, and a memoised suggestion lookup. Apply any extra fix the audit in `docs/perf-audit-2026-11-09.md` ranks highest and that lies in this workstream's files (list them in the report).
- [ ] **Step 4: Run** the full suite, typecheck, and if the audit gave a baseline, re-measure the Inbox on the phone and put the before and after numbers in the report.
- [ ] **Step 5: Commit** `perf(inbox): virtualised paged list, suggestions on demand`.

---

## Workstream W: all-time SMS window

### Task W1: "All time" choice

**Files:** Modify `src/ingest/pipeline.ts`, `src/state/setup.ts`, `src/state/BackfillChoice.tsx`, `app/(setup)/permissions.tsx`, `app/(tabs)/settings.tsx`, `docs/play-sms-declaration.md`, `docs/CONTEXT.md`; Test the existing pipeline, setup and screen tests.

**Interfaces:**
- Produces: `BACKFILL_CHOICES = [7, 30, 90, 180, 0] as const` where `0` means all time; label "All time"; `getBackfillDays` accepts `0`; the native call receives `0` as "no date limit".

- [ ] **Step 1: Write failing tests:** setting `'0'` calls `native.backfill(0, patterns)`; routine foreground cycles still read the short window (all-time is read only by setup and the Settings change); the label list contains "All time"; the disclosure text says "all your messages from the banks you set up" for it and still reads only configured senders.
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement**; keep `BACKFILL_OPTIONS` and `BACKFILL_CHOICES` defined once (export one from `pipeline.ts`, import in `setup.ts`).
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(setup): all-time message window`.

### Task W2: Native scan for an unlimited window, with truncation reported

**Files:** Modify `modules/sms-ingest/android/src/main/java/expo/modules/smsingest/SmsIngestModule.kt`, `modules/sms-ingest/src/index.ts`, `src/ingest/pipeline.ts`; Test the Kotlin unit tests and `src/ingest/pipeline.test.ts`.

**Interfaces:**
- Produces: the native `backfill(days, senderPatterns)` returns `{ messages: RawSms[]; truncated: boolean }`; `0` days means no lower date bound; the cap stays 5000 newest-first and `truncated` is true when more existed; `BackfillResult` gains `truncated?: boolean`; setup and Settings show "Showing the newest 5,000 messages. Older ones were not read." when true.

- [ ] **Step 1: Write failing tests** (Kotlin: a date-bound builder test for `0`; Jest: the bridge shape, `truncated` surfaced in the result and the message copy).
- [ ] **Step 2: Run** both test sets; fail. Kotlin command from `CLAUDE.md`; run it from `/Users/harris/projects/autoledger/android` is NOT possible in a worktree, so say in the report whether Kotlin tests ran.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full Jest suite and typecheck.
- [ ] **Step 5: Commit** `feat(sms-ingest): unlimited window with truncation flag`.

---

## Workstream D: warn when an SMS looks already booked

### Task D1: Pure similarity match

**Files:** Create `src/core/similar.ts`; Test `src/core/similar.test.ts`.

**Interfaces:**
- Produces:
  - `type BookedEntry = { doctype: string; name: string; postingDate: string; amountMinor: number; direction: 'in'|'out'|null; party: string | null; reference: string | null; docstatus: 0|1 }`
  - `type SimilarHit = { entry: BookedEntry; strength: 'strong'|'weak' }`
  - `findSimilar(txn: PendingTxn, entries: BookedEntry[]): SimilarHit | null`

- [ ] **Step 1: Write failing tests:** same reference is `strong`; same amount, same date and same normalised party/merchant is `strong`; same amount within 3 days and no party information is `weak`; different amount never matches; amounts compared in paise (₹1,000.40 vs ₹1,000.00 no match); cancelled entries (`docstatus` 2) are never passed in but a `docstatus` 2 input is ignored anyway; an entry the app itself created for this txn (reference `AL-` + rawHash or the txn's utr) is NOT reported as a duplicate; party names compared with `normalizeKey` from `suggest.ts`; the earlier hit wins deterministically when several match (closest date, then strong over weak).
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement** with integer paise and date-string day arithmetic.
- [ ] **Step 4: Run** tests and typecheck.
- [ ] **Step 5: Commit** `feat(core): similar-entry match`.

### Task D2: Load booked entries from ERPNext and flag pending items

**Files:** Modify `src/erp/docs.ts`; Create `src/ingest/dupCheck.ts`; Modify `src/state/cycle.ts`; Test `src/erp/docs.test.ts`, `src/ingest/dupCheck.test.ts`.

**Interfaces:**
- Produces: `listBookedEntries(c: ErpClient, company: string, fromDate: string, toDate: string): Promise<BookedEntry[]>` (Payment Entry, Journal Entry and Purchase Invoice with `docstatus` in 0 and 1, same company, paged, at most 3 requests per doctype); `runDupCheck(deps): Promise<void>` stores `possible_duplicate:<txnId>` as a setting holding `{name, doctype, strength}` JSON, clears it when no longer matching or when the txn is answered; one batch per cycle, never one request per row; runs only when ERPNext answers, and never blocks the cycle on failure.

- [ ] **Step 1: Write failing tests:** the date range is the span of pending items plus 3 days each side; one list request set per doctype regardless of pending count; a failure leaves old flags untouched and does not reject; flags are removed when the entry is cancelled; entries from another company are ignored.
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement**; wire into the end of the cycle after the status poll.
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(ingest): flag pending items that look already booked`.

### Task D3: Warning on the detail screen (warn only)

**Files:** Modify `app/txn/[id].tsx`, `src/inbox/describe.ts`; Test the detail screen test and `src/inbox/describe.test.ts`.

- [ ] **Step 1: Write failing tests:** a strong flag shows "This may already be in ERPNext" with a plain line "A payment of the same amount, on the same day, to the same party is already there." and a button "Open it in ERPNext"; a weak flag shows "A payment of the same amount a few days apart is already there"; in both cases the normal answer list still works and nothing is disabled; no flag, no banner.
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement** with the existing `Banner` and `openExternal`/`docUrl`.
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(inbox): warn when a payment may already be booked`.

---

## Workstream K: classifier and bulk answers (wave 3b, after I and D are merged)

Design: **Pattern** = normalised counterparty or merchant (existing `nameKey`) plus direction. **Group** = pending items with the same pattern. **Trust ladder:** (1) no rule: the item sits in the Inbox, and when a group has 2 or more items the Inbox shows one group card; (2) the user answers the group once with "Apply to all N"; (3) the app then asks "Do this automatically for new [name] payments?" (default Yes) and saves the rule with `auto: true`; (4) new items matching an auto rule are answered by the app after each scan and appear in Activity as "Done automatically" with Undo. Only expense, supplier payment, other income, personal and ignore can be bulk or automatic. Advances, salary, against invoice, bill paid by card and transfers always stay manual.

### Task K1: Rule trust fields and the safe-to-automate decision

**Files:** Modify `src/core/types.ts` (`Rule` gains `auto?: boolean; maxAmountMinor?: number; currency?: string`), `src/core/suggest.ts` (`learnRule` records the largest confirmed amount), `src/data/repo.ts` and its schema (new nullable columns, migration); Create `src/core/classify.ts`; Test `src/core/classify.test.ts`, `src/data/*` tests.

**Interfaces:**
- Produces: `groupSimilar(items: PendingTxn[], rules: Rule[]): {key: string; items: PendingTxn[]; suggestion: Partial<ActionChoice> | null}[]` (groups of size 2 or more) and `canAutoApply(txn: PendingTxn, rule: Rule, dupFlag: boolean): boolean`.

- [ ] **Step 1: Write failing tests:** grouping uses the exact normalised key (no substring matches: "facebook" never groups with "facebookads pvt" unless the keys are equal); `canAutoApply` is false for: rule not `auto`, action type outside the allowed five, foreign-currency txn, amount above `2 × maxAmountMinor`, a duplicate flag, direction mismatch, a rule without a complete choice; true for a normal Facebook card spend; the repo migration keeps existing rules (as `auto` false) and round-trips the new fields.
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(core): classifier groups and auto-apply guard`.

### Task K2: Bulk answer engine

**Files:** Create `src/inbox/bulk.ts`; Test `src/inbox/bulk.test.ts`.

**Interfaces:**
- Consumes: `submitAnswer` (`src/inbox/submit.ts`), `planAction`.
- Produces: `applyToGroup(deps: SubmitDeps, items: PendingTxn[], choice: ActionChoice, opts?: {concurrency?: number}): Promise<{done: string[]; failed: {id: string; message: string}[]}>`: runs items one at a time (concurrency 1 by default so correlation and outbox locks stay safe), never aborts on one failure, never creates a second document for an item that already has an answer.

- [ ] **Step 1: Write failing tests:** 5 items all succeed; item 3 fails and items 4 and 5 still run; retrying the failed id after fixing it does not duplicate the others; an item already answered is skipped; offline queues exactly as a single answer does.
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(inbox): bulk answer engine`.

### Task K3: Group card and bulk confirm screen

**Files:** Create `app/txn/bulk.tsx`; Modify `app/(tabs)/inbox.tsx`, `src/inbox/model.ts` (group cards at the top of the list), `src/ui/index.ts`; Test the Inbox and bulk screen tests.

- [ ] **Step 1: Write failing tests:** a group card reads "40 payments to Facebook, ₹1,24,000.00 in total" with the suggested answer or "Choose what these were"; tapping opens the bulk screen listing every item with a checkbox (all on) and the answer to apply (reusing the existing choose/party/account steps for the first item); "Apply to N" runs `applyToGroup` and shows "N done, M need your attention"; after success the screen asks "Do this automatically for new Facebook payments?" (default Yes, with "Not now"); items with a duplicate warning start unchecked.
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(inbox): group similar payments and answer them together`.

### Task K4: Automatic answers and the rules screen

**Files:** Create `src/ingest/autoApply.ts`, the rules section in Settings (new `app/(tabs)/rules.tsx` reachable from Settings); Modify `src/state/cycle.ts`, `app/(tabs)/activity.tsx` and `src/state/activityModel.ts` (a "Done automatically" chip), `app/(tabs)/settings.tsx` (a row "Automatic rules"); Test `src/ingest/autoApply.test.ts`, the screen tests.

- [ ] **Step 1: Write failing tests:** after a scan a new Facebook item matching an `auto` rule is answered through `applyToGroup` and appears in Activity with "Done automatically"; an item failing `canAutoApply` stays in the Inbox with the suggestion; at most 25 automatic answers per cycle (rest next cycle); turning a rule off in the rules screen stops the next run; the rules screen lists pattern, answer and "Used N times" with a switch and a Delete; no automatic write happens while signed out or offline (the item just waits).
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement**; the Inbox banner "3 payments were done automatically. See Activity".
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(ingest): answer confirmed patterns automatically`.

---

## Parallel execution

1. Wave 3a: the controller creates four worktrees from `phase1` (`wave3-p`, `wave3-i`, `wave3-w`, `wave3-d`) and dispatches P (needs the phone), I, W and D at once, one implementer each (most capable model for D and K, mid-tier for I and W, a mid-tier model with shell access for P).
2. A reviewer per workstream, one fix round (resume the implementer), merge one at a time into `phase1`, `npx tsc --noEmit` and `npx jest` after each merge.
3. Wave 3b: K starts from the merged `phase1`; per-task review because K writes to ERPNext.
4. A final whole-branch review on the most capable model, one fix dispatch, one scoped re-review.
5. Stage check for K (a real automatic answer creating a draft on stage) and the Sales Order link from wave 2 each need the user's go-ahead.

## Backlog

- Subtract unsubmitted local advances from an order's "left to pay".
- "To Pay" order status check on stage.
- Salary as a Bank Entry, "Do you have a GST bill?" path (both wait for the accountant).
- Home hero card, manual "+" entry, receivables/payables ageing, mini MIS, runway.
- Phase 2: statement PDF import to Bank Transactions.
