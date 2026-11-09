# Wave 2: accounting fit, Activity UI, SMS window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make advances land on the right Sales Order, make the Activity list searchable and filterable with money-direction colours, and let the user choose how far back the SMS scan reads.

**Architecture:** Three independent workstreams (A, B, C) with disjoint file sets, so they run in parallel in git worktrees under `.superpowers/wt/<name>`. Pure logic goes in `src/core` or view-model files with tests first; screens stay thin. Later waves (section "Backlog") are listed, not specified.

**Tech Stack:** Expo SDK 58, React Native 0.88, TypeScript, Expo Router, NativeWind v4, expo-sqlite, Jest with React Native Testing Library, Kotlin module `modules/sms-ingest`.

**Spec:** `docs/superpowers/specs/2026-11-08-autoledger-design.md`, `docs/CONTEXT.md`, `docs/ui-audit-2026-11-09.md`. Findings behind this plan come from a read-only look at the stage site and the Cashiro reference app (`reference/Cashiro`, git-ignored).

## Global Constraints

- Writes go ONLY to the stage site. Production (`atom.onebook.app`) is read-only and only when the user asks.
- Only DRAFTS (`docstatus` 0). Never submit. No Bank Transaction in this wave.
- Credentials only in git-ignored `.env.local`. Never print, log or commit them.
- Raw SMS text never leaves the device and is never persisted. No raw SMS in logs, tests or crash reports.
- Money is integer minor units (paise) in `src/core`. No floats for amounts.
- Do not push to GitHub. Add files by name; never `git add -A` in a worktree.
- Copy: plain language for a non-accountant, sentence case, no em dashes, no jargon as primary text (no "UTR", "Debit/Credit", doctype names or document ids). Dates `8 Nov 2026`, true minus `−` for money out.
- Light AND dark themes: colours from NativeWind tokens in `tailwind.config.js`. Touch targets at least 48 dp. Icons decorative and beside a text label; screens import icons only through `src/ui` (`Icon`, add a name to `ICONS` first).
- Strict TypeScript, 2-space indent, single quotes, semicolons, trailing commas. Commits `type(scope): summary` ending with the session's `Co-Authored-By` line.
- `npx tsc --noEmit` clean and `npx jest` green before every commit that ends a task.

## File ownership (no two workstreams edit the same file)

| Workstream | Owns |
|---|---|
| A: Sales Order link | `src/core/types.ts`, `src/core/plan.ts`(+test), `src/erp/docs.ts`(+test), `src/inbox/actions.ts`(+test), `src/inbox/flow.ts`, `app/txn/party.tsx`, new `app/txn/order.tsx`, `app/txn/confirm.tsx`, `src/inbox/describe.ts` |
| B: Activity UI | `app/(tabs)/activity.tsx`, `src/state/activityModel.ts`(+test), `src/ui/ActivityRow.tsx`, `src/ui/TxnRow.tsx`, `src/ui/index.ts`, `src/ui/Icon.tsx`, `tailwind.config.js`, new `src/ui/FilterSheet.tsx`, new `src/ui/SearchField.tsx` |
| C: SMS window | `src/ingest/pipeline.ts`(+test), `src/state/setup.ts`, `app/(setup)/permissions.tsx`, `app/(tabs)/settings.tsx`, `docs/play-sms-declaration.md`, `docs/CONTEXT.md` |

If a task needs a file owned by another workstream, stop and tell the controller instead of editing it.

## Review Focus

- A customer advance with no matching open Sales Order: the user must still be able to book a plain advance (current behaviour).
- An advance larger than the order's remaining amount: block with a plain message, never create a Payment Entry ERPNext will reject.
- One payment split over two orders of the same customer: allocations must add up to at most the payment, in paise.
- Activity search with only spaces, mixed case, or a merchant containing regex characters like `(` or `*`: must not crash or match everything.
- Backfill window set to a larger value after items were already answered: re-reading old messages must not create duplicates or reopen answered items (same `rawHash` dedupe).

---

## Workstream A: advances land on the Sales Order

### Task A1: Plan allows a Sales Order reference on a customer advance

**Files:**
- Modify: `src/core/types.ts` (the `customer_advance` variant)
- Modify: `src/core/plan.ts` (case `'customer_advance'`)
- Test: `src/core/plan.test.ts`

**Interfaces:**
- Produces: `{type:'customer_advance'; party: PartyRef; orders?: {name: string; allocatedMinor: number}[]}` in `ActionChoice`.

- [ ] **Step 1: Write failing tests** in `plan.test.ts`:
  - `customer_advance with one order adds a Sales Order reference`: advance of 25,000.00 with `orders:[{name:'SAL-ORD-2026-2027-00004', allocatedMinor: 2_500_000}]` gives a Payment Entry whose `references` equals `[{reference_doctype:'Sales Order', reference_name:'SAL-ORD-2026-2027-00004', allocated_amount: 25000}]`.
  - `customer_advance without orders is unchanged`: no `references` key in the body.
  - `customer_advance over-allocated throws PlanError('over_allocated')` when allocations sum above the transaction amount.
  - `customer_advance with an empty orders array behaves like no orders`.
- [ ] **Step 2: Run** `npx jest src/core/plan.test.ts` and confirm the new tests fail.
- [ ] **Step 3: Implement** the type change and the case: map `orders` to `references` using `minorToMajor`, reuse the existing over-allocation check, extend the summary line to name the order ("for order X"). Copy stays plain: "Payment Entry (draft)" lines are internal; user-facing text is built in A4.
- [ ] **Step 4: Run** `npx jest src/core/plan.test.ts` and `npx tsc --noEmit`; both pass.
- [ ] **Step 5: Commit** `feat(plan): customer advance can reference Sales Orders`.

### Task A2: List a customer's open Sales Orders

**Files:**
- Modify: `src/erp/docs.ts`
- Test: `src/erp/docs.test.ts`

**Interfaces:**
- Produces: `listOpenSalesOrders(c: ErpClient, customer: string): Promise<OpenOrder[]>` with `type OpenOrder = { name: string; totalMinor: number; advanceMinor: number; remainingMinor: number; deliveryDate: string | null }`.

- [ ] **Step 1: Write failing tests** with the fake client used by the other `docs.test.ts` cases: returns only `docstatus` 1 orders that are not Closed, Cancelled or Completed; `remainingMinor = totalMinor - advanceMinor` computed through `toMinor` (no float maths); orders with remaining 0 are omitted; sorted oldest first.
- [ ] **Step 2: Run** `npx jest src/erp/docs.test.ts`; fails.
- [ ] **Step 3: Implement** with a `frappe.client.get_list` on `Sales Order`, fields `name, grand_total, advance_paid, delivery_date, status`, filters `customer`, `docstatus=1`, `status in ['To Deliver and Bill','To Bill','To Deliver']`. Path segments encoded as the other helpers do.
- [ ] **Step 4: Run** tests and `npx tsc --noEmit`; pass.
- [ ] **Step 5: Commit** `feat(erp): list a customer's open Sales Orders`.

### Task A3: Order step in the answer flow

**Files:**
- Create: `app/txn/order.tsx`
- Modify: `src/inbox/flow.ts`, `src/inbox/actions.ts`, `app/txn/party.tsx` (navigate to the new step after choosing a customer for an advance)
- Test: `src/inbox/flow.test.ts`, `src/inbox/actions.test.ts`

**Interfaces:**
- Consumes: `listOpenSalesOrders` (A2), `ActionChoice` with `orders` (A1).
- Produces: flow state `orders: {name: string; allocatedMinor: number}[]` and an action `chooseOrders(orders)`.

- [ ] **Step 1: Write failing tests**: flow keeps selected orders; `Skip, no order` clears them; selecting orders whose allocations exceed the payment is rejected with the message "That is more than this payment. Lower the amount for an order."; allocation defaults to `min(remaining, paymentLeft)` in paise.
- [ ] **Step 2: Run** the two test files; fail.
- [ ] **Step 3: Implement** the flow state and `app/txn/order.tsx` (checkbox rows, one amount per selected order, a clear "Skip, this is not for an order" button). Title: "Which order is this for?". Show the customer, order total, already paid and left to pay in plain words. No order list (customer has none) goes straight on.
- [ ] **Step 4: Run** tests and `npx tsc --noEmit`; pass.
- [ ] **Step 5: Commit** `feat(inbox): ask which order an advance is for`.

### Task A4: Confirm and describe screens show the order

**Files:**
- Modify: `app/txn/confirm.tsx`, `src/inbox/describe.ts`
- Test: `src/inbox/describe.test.ts`

- [ ] **Step 1: Write failing test**: describing a customer advance with orders gives the line "Advance for order SAL-ORD-... " in plain words and never the words "Payment Entry" in the primary text.
- [ ] **Step 2: Run** `npx jest src/inbox/describe.test.ts`; fails.
- [ ] **Step 3: Implement** the copy change in `describe.ts`; render it in `confirm.tsx`.
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Stage check (needs the user's go-ahead):** answer one real stage SMS with an advance for a stage Sales Order, open the draft in ERPNext and confirm the Payment Entry references the order. Delete nothing the app did not create. Commit `test(stage): advance links to order` only if a stage test file is added.

---

## Workstream B: Activity list with search, period chips, totals, direction colours

### Task B1: Pure filter, totals and grouping functions

**Files:**
- Modify: `src/state/activityModel.ts`
- Test: `src/state/activityModel.test.ts`

**Interfaces:**
- Produces:
  - `type ActivityPeriod = 'this_month' | 'last_month' | 'this_fy' | 'all'`
  - `filterActivity(items: PendingTxn[], f: {query: string; period: ActivityPeriod; direction?: 'in'|'out'; accountLast4?: string}, today: string): PendingTxn[]`
  - `totalsOf(items: PendingTxn[]): {inMinor: number; outMinor: number; netMinor: number}` (INR only; foreign currency items are counted separately in `foreignCount`)
  - `groupByRecency(items: PendingTxn[], today: string): {title: 'Today'|'Yesterday'|'This week'|'Earlier'; rows: PendingTxn[]}[]`
  - `sortActivity(items, by: 'newest'|'oldest'|'amount_high'|'amount_low'|'name_az'): PendingTxn[]`

- [ ] **Step 1: Write failing tests** with fixed `today = '2026-11-09'`: this month vs last month boundaries; financial year starts 1 April (stage FY is 2026-2027); query is case-insensitive and trimmed; `'('`, `'*'` and `'   '` do not throw and spaces-only matches everything; totals in integer paise; `groupByRecency` omits empty groups; each sort option.
- [ ] **Step 2: Run** `npx jest src/state/activityModel.test.ts`; fails.
- [ ] **Step 3: Implement** with plain string `includes` (no `new RegExp` from user text) and date strings compared lexically on `occurredOn`.
- [ ] **Step 4: Run** tests and typecheck; pass.
- [ ] **Step 5: Commit** `feat(activity): filter, totals, grouping and sort model`.

### Task B2: Money-direction tokens and row styling

**Files:**
- Modify: `tailwind.config.js` (add `money-in` and `money-out` colours with `-dark` variants), `src/ui/ActivityRow.tsx`, `src/ui/TxnRow.tsx`, `src/ui/contrast.test.ts` (add the new tokens)
- Test: `src/ui/contrast.test.ts`, `src/ui/TxnRow.test.tsx`

- [ ] **Step 1: Write failing tests**: both new tokens meet 4.5:1 contrast on the card background in light and dark (extend the existing contrast test); `TxnRow` renders the money-in style for `direction='in'` and money-out for `'out'`; the amount text still carries the sign and the accessibility label (colour is never the only signal).
- [ ] **Step 2: Run** the two tests; fail.
- [ ] **Step 3: Implement** the tokens and the row classes; keep the true minus.
- [ ] **Step 4: Run** tests and typecheck; pass.
- [ ] **Step 5: Commit** `feat(ui): money in/out colours on rows`.

### Task B3: Search field, period chips and totals strip on Activity

**Files:**
- Create: `src/ui/SearchField.tsx`
- Modify: `app/(tabs)/activity.tsx`, `src/ui/index.ts`, `src/ui/Icon.tsx` (add a `search` icon name)
- Test: `src/state/activityScreen.test.tsx`

**Interfaces:**
- Consumes: B1 functions. Produces: `SearchField({value, onChange, placeholder, testID})` exported from `src/ui`.

- [ ] **Step 1: Write failing screen tests**: typing "fuel" hides other rows; tapping "Last month" changes the list; the totals strip shows "Money in", "Money out" and "Net" for the shown rows; the empty state says "Nothing matches. Try a different search or period."; Undo and Put back still work on a filtered row.
- [ ] **Step 2: Run** `npx jest src/state/activityScreen.test.tsx`; fails.
- [ ] **Step 3: Implement**; the chips use the existing `Chip`; the strip uses `Figure`/`Money`; headers come from `groupByRecency`; sentence case.
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(activity): search, period chips and totals`.

### Task B4: Filter and sort sheet

**Files:**
- Create: `src/ui/FilterSheet.tsx`
- Modify: `app/(tabs)/activity.tsx`, `src/ui/index.ts`
- Test: `src/state/activityScreen.test.tsx`

- [ ] **Step 1: Write failing tests**: opening "Filters" shows direction (All, Money in, Money out), account and sort; Apply updates the list and shows a count on the Filters button ("Filters (2)"); Reset clears it.
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Implement** as a bottom sheet built on the existing `ActionSheet` primitives; targets at least 48 dp.
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(activity): filter and sort sheet`.

---

## Workstream C: configurable SMS window

### Task C1: Window setting used by the backfill

**Files:**
- Modify: `src/ingest/pipeline.ts`
- Test: `src/ingest/pipeline.test.ts`

**Interfaces:**
- Produces: `BACKFILL_DAYS_KEY = 'backfill_days'`, `BACKFILL_CHOICES = [7, 30, 90, 180] as const`, `DEFAULT_BACKFILL_DAYS = 7`, and `ensureBackfill` reads the setting (a value not in `BACKFILL_CHOICES` falls back to 7). `BACKFILL_DAYS` stays exported as an alias of the default so existing imports compile.

- [ ] **Step 1: Write failing tests**: with the setting `'90'` the native `backfill` is called with `90`; with no setting, `7`; with `'abc'`, `7`; raising the window after items were answered creates no duplicate (same `rawHash`).
- [ ] **Step 2: Run** `npx jest src/ingest/pipeline.test.ts`; fails.
- [ ] **Step 3: Implement** reading the setting through `deps.repo.getSetting`.
- [ ] **Step 4: Run** tests and typecheck; pass.
- [ ] **Step 5: Commit** `feat(ingest): configurable backfill window`.

### Task C2: Choice in setup and Settings

**Files:**
- Modify: `src/state/setup.ts`, `app/(setup)/permissions.tsx`, `app/(tabs)/settings.tsx`
- Test: `src/state/setup.test.ts`, the permissions and settings screen tests

- [ ] **Step 1: Write failing tests**: the permissions step shows "How far back should we look?" with "1 week", "1 month", "3 months", "6 months"; the choice is saved as `backfill_days`; Settings shows the current choice and lets the user change it; changing it re-runs the backfill once.
- [ ] **Step 2: Run**; fail.
- [ ] **Step 3: Implement**; after the scan, show "Found N transactions" using the counts the backfill result already returns (read `IngestResult` for the field names).
- [ ] **Step 4: Run** the full suite and typecheck.
- [ ] **Step 5: Commit** `feat(setup): choose how far back to read messages`.

### Task C3: Disclosures and docs

**Files:**
- Modify: `app/(setup)/permissions.tsx` (disclosure text), `docs/play-sms-declaration.md`, `docs/CONTEXT.md`

- [ ] **Step 1: Write a failing test** that the disclosure text no longer says "7 days" as a fixed fact and states that only messages from the senders you set up are read, for the chosen period.
- [ ] **Step 2: Run**; fails.
- [ ] **Step 3: Update** the text and docs; record the ruling "window is user-chosen, default 1 week, senders still limited to configured banks" in `docs/CONTEXT.md`.
- [ ] **Step 4: Run** the full suite.
- [ ] **Step 5: Commit** `docs: backfill window is user-chosen`.

---

## Parallel execution

1. The controller creates three worktrees from `phase1`: `.superpowers/wt/ws-a`, `ws-b`, `ws-c`.
2. One implementer subagent per workstream, tasks in order inside a workstream. Explicit model per agent: the most capable model for A (accounting rules), a mid-tier model for B and C.
3. A reviewer per workstream after its last task, then the controller merges A, B, C into `phase1` one at a time, running `npx tsc --noEmit` and `npx jest` after each merge. Conflicts should be limited to `docs/CONTEXT.md`.
4. Jest in a worktree needs the temp config described in `CLAUDE.md`.

## Backlog (not specified here, each needs its own plan)

- Salary as a Bank Entry Journal Entry like the accountant (confirm with the accountant first).
- "Do you have a GST bill?" path creating a Purchase Invoice plus Payment Entry (confirm with the accountant first).
- Clearer vendor choice: vendor with a bill, vendor without a bill, no vendor.
- Detail screen polish, merchant icons, navigation icons, Home hero card and manual "+" entry.
- Unrecognised-messages screen (parsed fields only).
- Account auto-detect in setup; skip-older action for large backfills; ICICI templates.
- Receivables/payables ageing screen, mini MIS, runway, projections (with a "based on submitted entries, N drafts waiting" line).
- Phase 2: statement PDF/CSV import to Bank Transactions, per-bank statement templates (needs a redacted IDFC sample), dedupe against SMS.
