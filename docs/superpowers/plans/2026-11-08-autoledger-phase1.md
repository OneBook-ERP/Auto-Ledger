# AutoLedger Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Android app that reads IDFC bank/card SMS, asks the user one question per transaction, and creates draft Payment Entries / Journal Entries in a vanilla ERPNext site, plus a small trust-labelled dashboard.

**Architecture:** Expo (React Native, TypeScript) app talking directly to ERPNext REST with a per-user API key; no backend of ours. All SMS parsing rules live in one JSON template file executed by both a TypeScript engine (source of truth) and a Kotlin engine (so the receiver can read amount/direction for a notification while the app is dead). Pure-TypeScript `core/` modules (parser, correlation, action planner, suggestions, outbox) hold all money logic and are unit tested; screens are thin.

**Tech Stack:** Expo dev client + prebuild, TypeScript, Expo Router, expo-sqlite, expo-secure-store, TanStack Query, Zustand, Jest (jest-expo) + React Native Testing Library, a local Expo module in Kotlin (JUnit), NativeWind v4 (UI kit decided in Task 1), EAS Build/Update, Sentry.

**Spec:** `docs/superpowers/specs/2026-11-08-autoledger-design.md` (approved 2026-11-08). Read it first; this plan cites its sections as §n.

## Global Constraints

- Vanilla ERPNext only: no custom app, no server of ours. Pilot site runs ERPNext 16.53 / Frappe 16.54 / India Compliance 16.11; target v15 and v16.
- Android only. INR accounting; single company per login.
- **Writes go to `https://stageatom.onebook.app` only.** `https://atom.onebook.app` is live production: read-only, and only if the user asks. Credentials come from `.env.local` (git-ignored): `ONEBOOK_STAGE_URL`, `ONEBOOK_STAGE_KEY`, `ONEBOOK_STAGE_SECRET`. Never commit credentials, API keys or raw SMS.
- Every created document is a **draft** (`docstatus = 0`). The app never submits, never creates Bank Transactions, never reconciles (§3).
- The password is never stored; API key/secret live in secure storage. HTTPS required except in debug builds (§15).
- Raw SMS text never leaves the device. OTP and promotional messages are dropped before storage (§15).
- SMS permissions `RECEIVE_SMS` + `READ_SMS`, configured senders only; backfill window 7 days (§7.3).
- Stale-data threshold for the dashboard: 24 h (§14).
- Learned rules stay on one device (§3). Rules never auto-post in phase 1 (§7.8).
- Currency amounts are integers in minor units (`amountMinor`); no floating-point money.

## Review Focus

Inputs the spec implies but does not enumerate; each has a pinning test in the owning task.

1. Indian number grouping and prefixes: `INR 5,12,932.76`, `Rs. 115,000.00`, `Rs 8,000.00`, `INR 78948.53` all parse to exact minor units (Task 5).
2. The same SMS delivered twice (live receiver + 7-day backfill overlap) creates one item (Tasks 6, 15).
3. Failure halfway through a multi-document action (party created, Payment Entry rejected) leaves no orphan on retry and no duplicate party (Task 13).
4. A site that requires a custom field the app does not know, or a posting date in a closed accounting period: surfaced as a readable error with a "complete in ERPNext" path, not a crash or silent skip (Tasks 10, 11, 13).
5. API key revoked or rotated mid-session (HTTP 401/403): the app asks the user to sign in again and keeps the queued work (Tasks 10, 13).

## File Structure

```
app/                         Expo Router screens (thin)
  _layout.tsx, (auth)/login.tsx, (setup)/*.tsx, (tabs)/{home,inbox,activity,settings}.tsx, txn/[id].tsx
src/core/                    pure TS, no RN imports
  types.ts, money.ts, parser/{engine.ts,index.ts}, correlate.ts, plan.ts, suggest.ts, trust.ts
src/data/                    expo-sqlite: schema.ts, repo.ts
src/erp/                     client.ts, auth.ts, docs.ts, reports.ts
src/ingest/                  pipeline.ts, templates.ts (remote fetch + bundled fallback)
src/outbox/runner.ts
src/state/                   zustand stores
modules/sms-ingest/          local Expo module (Kotlin): android/…, src/index.ts
templates/idfc.json          shared template file (bundled copy)
fixtures/sms/idfc.json       redacted SMS fixtures with expected parses
scripts/                     redact-sms.ts, spike/*.ts
docs/                        spike-report.md, play-sms-declaration.md
```

## Shared types (defined in Task 5/6, used everywhere)

```ts
// src/core/types.ts
export type TxnKind = 'ca_credit'|'ca_debit'|'neft_confirm'|'card_spend'|'card_si_paid';
export interface ParsedTxn {
  kind: TxnKind; direction: 'in'|'out'; amountMinor: number; currency: string;
  occurredOn: string;            // YYYY-MM-DD, from the SMS body
  occurredTime: string | null;   // HH:mm 24h, IST, or null
  accountType: 'bank'|'card'; accountLast4: string | null;
  counterparty: string | null; utr: string | null; merchant: string | null;
  balanceMinor: number | null; sender: string; receivedAt: number; rawHash: string;
}
export type IgnoreReason = 'otp'|'si_notice'|'not_money'|'unknown_template';
export type ParseResult = { ok: true; txn: ParsedTxn } | { ok: false; reason: IgnoreReason };
export interface PendingTxn extends ParsedTxn {
  id: string; state: 'new'|'created'|'submitted'|'ignored'|'failed';
  createdDocs: { doctype: string; name: string; docstatus: number }[]; error: string | null;
}
```

---

### Task 1: Project scaffold, test harness, UI kit decision

**Files:** Create the Expo project in the repo root (`package.json`, `app.json`, `tsconfig.json`, `jest.config.js`, `.gitignore` incl. `.env.local`, `.env.example`), `README.md`.

**Interfaces:**
- Produces: `npm test` runs Jest; `npm run typecheck`; `npx expo prebuild` + a dev-client Android build installs on the pilot phone.

- [ ] **Step 1:** `git init` inside `autoledger/` so the app has its own history (the parent folder is a repo of unrelated projects). **My call, flag to the user if they object.**
- [ ] **Step 2:** Scaffold Expo with TypeScript + Expo Router; add Jest with a trivial passing test `src/core/money.test.ts` placeholder removed in Task 5. Verify: `npm test` → 1 passed; `npm run typecheck` → no errors.
- [ ] **Step 3:** Install NativeWind v4 and copy in one NativeWindUI component (a list row). Build a dev client and render it on the phone. If NativeWind or NativeWindUI does not build cleanly on the chosen Expo SDK within one hour, fall back to React Native Paper and record the choice in `README.md` under "UI kit". Screens depend only on `src/ui/` wrappers so the kit stays swappable.
- [ ] **Step 4:** Commit `chore: scaffold expo app, jest, ui kit`.

### Task 2: Spike A: SMS receiver survives the OEM on the real phone

**Files:** Create `modules/sms-ingest/` (minimal), `docs/spike-report.md` (section A).

**Interfaces:** Produces: go/no-go for the Kotlin receiver. If **no-go**, stop and escalate: the fallback is native Kotlin (spec §6).

- [ ] **Step 1:** Minimal Kotlin `BroadcastReceiver` for `SMS_RECEIVED` that appends `{sender, body, ts}` to a SharedPreferences list and posts a notification, registered in the module manifest; request `RECEIVE_SMS` at runtime.
- [ ] **Step 2:** On the pilot phone (CPH2487) force-stop the app by swiping it away, screen off, and send a real SMS from another handset. For the spike only, configure the receiver's sender filter to accept that handset's number (the IDFC filter arrives in Task 9). Record whether the notification appears and whether the queue holds the message after 10 minutes idle.
- [ ] **Step 3:** Repeat with battery optimisation set to default and then to "allow background activity". Record exact steps the user must take (feeds Task 16 onboarding copy).
- [ ] **Step 4:** Write findings and the go/no-go in `docs/spike-report.md`. Commit `docs: spike A result`.

### Task 3: Spike B: ERPNext API behaviour on stage (v16)

**Files:** Create `scripts/spike/erp-spike.ts`, `docs/spike-report.md` (section B).

**Interfaces:** Produces answers that Tasks 10–13 depend on. All calls target stage with the env credentials.

- [ ] **Step 1:** Script checks, each printing PASS/FAIL with the response body on failure:
  1. token auth works (`frappe.auth.get_logged_user`);
  2. login with username/password then `frappe.core.doctype.user.user.generate_keys` returns a secret, and whether an existing `api_key` is readable beforehand (use a throwaway test user, not the real one, since this rotates the secret);
  3. a draft Payment Entry (Receive, unallocated, Customer) with `reference_no` = UTR and `reference_date` is created, found by `reference_no` filter, and deleted while `docstatus = 0`;
  4. a draft Journal Entry with `cheque_no` = UTR, two rows (expense / card liability account), found by `cheque_no`, deleted;
  5. a Payment Entry (Pay, Supplier, against a test Purchase Invoice) with `paid_from` = the card liability account (`IDFC Credit Card - ZP`) is accepted; if rejected, check whether a Journal Entry with a party row and invoice reference is accepted instead;
  6. an Internal Transfer Payment Entry from `IDFC First - ZP` to `IDFC Credit Card - ZP`;
  7. `frappe.desk.form.load.getdoctype` for Customer returns required fields (and GST fields from India Compliance);
  8. `frappe.desk.query_report.run` for Accounts Receivable Summary and `erpnext.accounts.utils.get_balance_on` return numbers for the pilot company;
  9. creating a document dated in a closed period, and a Customer missing a required field, return identifiable error payloads.
- [ ] **Step 2:** Decide `frappe-js-sdk` versus a thin client by checking it imports and authenticates inside the Task 1 dev client. Record the choice (default: thin typed client over `fetch`).
- [ ] **Step 3:** Record every method name/shape that differs from spec §11 in `docs/spike-report.md`; later tasks must use the recorded names. Commit `docs: spike B result`.

### Task 4: Redacted SMS fixtures

**Files:** Create `scripts/redact-sms.ts`, `fixtures/sms/idfc.json`, test `scripts/redact-sms.test.ts`.

**Interfaces:**
- Produces: `fixtures/sms/idfc.json`: `Array<{ id: string; sender: string; body: string; receivedAt: number; expected: ({ ok: true; txn: Partial<ParsedTxn> } | { ok: false; reason: IgnoreReason }) }>`. Consumed by Tasks 5, 6, 8.

- [ ] **Step 1: Failing test** `redact-sms.test.ts`: `redact(body)` replaces any digit run of 6+ and any `X`-masked account number with the same-length `9`s/`X`s, replaces person/company names after `from `, `Info: NEFT/…/`, `beneficiary ` with `PERSON_<n>` (stable per name within a run), and keeps amounts, dates, merchant names, UTR *shape* (`IDFB` + same-length digits). Assertions include: output contains no digit run ≥ 9; `INR 1,30,000.00` unchanged; same input name → same placeholder.
- [ ] **Step 2:** Run; expect FAIL (module missing).
- [ ] **Step 3:** Implement `redact(body: string, names: NameMap): string` and a CLI `ts-node scripts/redact-sms.ts <input.json> <output.json>` that also drops OTP messages. The input is the pilot export (kept outside the repo; ask the user for it or re-export with adb).
- [ ] **Step 4:** Run; expect PASS. Generate fixtures covering at least: short CA credit/debit, long CA credit/debit (with `Info:`), both NEFT-confirm variants (with and without a name), card spend INR, card spend USD, "Fueled Up!/Delicious Purchase!" prefixes, SI paid, SI "will be deducted", limit-alert, eStatement, marketing. Hand-write the `expected` for each, using the observations in spec §17A.
- [ ] **Step 5:** Manually confirm no real names/numbers remain (`grep -E '[0-9]{9,}'` returns nothing). Commit `test: redacted idfc sms fixtures`.

### Task 5: Template engine and IDFC templates (TypeScript)

**Files:** Create `src/core/types.ts`, `src/core/money.ts`, `src/core/parser/engine.ts`, `src/core/parser/index.ts`, `templates/idfc.json`; tests `src/core/money.test.ts`, `src/core/parser/parser.test.ts`.

**Interfaces:**
- Produces:
  - `parseMinor(text: string): number` (money.ts): handles `INR`/`Rs.`/`Rs ` prefixes, Indian and western grouping.
  - `parseSms(sender: string, body: string, receivedAt: number, templates: TemplateSet): ParseResult`.
  - `TemplateSet = { version: number; banks: { id: string; senderPattern: string; templates: { id: string; kind: TxnKind | 'ignore'; direction?: 'in'|'out'; ignoreReason?: IgnoreReason; accountType: 'bank'|'card'; regex: string }[] }[] }`. Regexes use **named groups only from this set**: `amount, currency, day, month, year, time, last4, counterparty, utr, merchant, balance`, and only syntax valid in both JS and Java (no variable-length lookbehind). `month` accepts `08`, `NOV`.

- [ ] **Step 1: Failing tests** (`money.test.ts`): `parseMinor('INR 5,12,932.76') === 51293276`, `parseMinor('Rs. 115,000.00') === 11500000`, `parseMinor('Rs 8,000.00') === 800000`, `parseMinor('INR 78948.53') === 7894853`, `parseMinor('USD 100.00') === 10000`.
- [ ] **Step 2: Failing tests** (`parser.test.ts`): run every fixture in `fixtures/sms/idfc.json` and compare to `expected`; plus named cases:
  - short CA credit → `{kind:'ca_credit', direction:'in', amountMinor:1293200, occurredOn:'2026-09-02', occurredTime:'09:13', counterparty:null, utr:null, balanceMinor:51293276}`;
  - long CA credit → `counterparty` equal to that fixture's redacted name (e.g. `'COMPANY_88'`), `accountLast4:'6507'`, `occurredTime:null`;
  - USD card spend → `{kind:'card_spend', currency:'USD', amountMinor:10000, accountLast4:'3455', merchant:'ANTHROPIC* CLAUDE SUB', occurredOn:'2026-11-08', occurredTime:'17:41'}`;
  - "will be deducted" SI → `{ok:false, reason:'si_notice'}`; "paid from … standing instruction" → `kind:'card_si_paid'`;
  - an OTP body → `{ok:false, reason:'otp'}`; a limit alert → `{ok:false, reason:'not_money'}`; sender `AX-HDFCBK-S` → `{ok:false, reason:'unknown_template'}`;
  - `rawHash` is stable for identical (sender, body, receivedAt-minute).
- [ ] **Step 3:** Run; expect FAIL.
- [ ] **Step 4:** Implement `engine.ts` (sender match on `senderPattern` substring, first matching template wins, OTP check first) and write `templates/idfc.json`. Run; expect all PASS.
- [ ] **Step 5:** Commit `feat: sms template engine and idfc templates`.

### Task 6: Correlation and de-duplication

**Files:** Create `src/core/correlate.ts`; test `src/core/correlate.test.ts`.

**Interfaces:**
- Consumes: `ParsedTxn`, `PendingTxn`.
- Produces: `correlate(existing: PendingTxn[], incoming: ParsedTxn): Correlation` where `Correlation = {action:'insert'} | {action:'drop_duplicate'; of:string} | {action:'enrich'; target:string; patch: Partial<ParsedTxn>}`.

- [ ] **Step 1: Failing tests:** (a) identical `rawHash` → `drop_duplicate` (Review Focus 2); (b) `neft_confirm` with same `amountMinor` as an existing `ca_debit` lacking `utr`, within 48 h → `enrich` with `{counterparty, utr}`; (c) `neft_confirm` with no matching debit → `insert`; (d) `card_si_paid` and `card_spend` with same normalised merchant (case/space/punctuation-insensitive), same amount and `occurredOn` within 2 days → `drop_duplicate`; (e) two genuine same-day Facebook charges with different amounts → both `insert`; (f) a matching debit already `state:'created'` still accepts `enrich` and the patch is returned (the runner decides what to do).
- [ ] **Step 2:** Run; expect FAIL. **Step 3:** Implement. **Step 4:** Run; PASS. **Step 5:** Commit `feat: correlate sms into single transactions`.

### Task 7: Local database

**Files:** Create `src/data/schema.ts`, `src/data/repo.ts`; test `src/data/repo.test.ts` (using an in-memory SQLite driver for Jest).

**Interfaces:**
- Produces `Repo` with: `listPending(state?: PendingTxn['state']): Promise<PendingTxn[]>`, `upsertPending(t: PendingTxn): Promise<void>`, `getPending(id): Promise<PendingTxn|null>`, `saveMapping(m: AccountMapping)`, `listMappings()`, `saveRule(r: Rule)`, `listRules()`, `enqueue(op: OutboxOp)`, `nextOutbox()`, `markOutbox(id, patch)`, `getSetting(key)`, `setSetting(key, value)`.
- `AccountMapping = { bankAccount: string; glAccount: string; kind: 'bank'|'card'; senderIds: string[]; last4: string[] }` (several last-4 per account, spec §17A.5). `Rule = { matchKey: string; action: ActionChoice['type']; party?: PartyRef; account?: string; hits: number; lastUsed: number }`.

- [ ] **Step 1: Failing tests:** round-trip each entity; `createdDocs` persists as JSON; mapping with last4 `['3455','8129']` resolves for both; `upsertPending` is idempotent on `rawHash`; a v1→v2 migration test keeps rows. **Steps 2–5:** run/fail, implement, run/pass, commit `feat: local sqlite repo`.

### Task 8: Kotlin template engine with conformance test

**Files:** Create `modules/sms-ingest/android/src/main/java/.../TemplateEngine.kt`; JUnit test `TemplateEngineTest.kt` reading `fixtures/sms/idfc.json` and `templates/idfc.json`.

**Interfaces:**
- Produces: `TemplateEngine.parse(sender: String, body: String): NativeParse?` with `NativeParse(kind, direction, amountMinor, currency, accountLast4)` (enough for a notification), returning `null` for OTP / ignore / unknown.
- Consumes: the same `templates/idfc.json` as Task 5. Copy happens via a build step, not by hand, so the two cannot drift.

- [ ] **Step 1: Failing JUnit test:** for every fixture, `parse` returns null exactly when `expected.ok == false`, and otherwise matches `kind`, `direction`, `amountMinor`, `currency`, `accountLast4` from `expected`. **Steps 2–4:** run (`./gradlew :sms-ingest:testDebugUnitTest`, expect FAIL), implement with `java.util.regex`, run (PASS). Add a Gradle/npm step that copies `templates/idfc.json` into the module assets.
- [ ] **Step 5:** Commit `feat: kotlin template engine matching ts parser`.

### Task 9: Native receiver, queue, notification, JS bridge

**Files:** Modify `modules/sms-ingest/` (receiver, `SmsQueue.kt`, `NotificationPoster.kt`, `SmsIngestModule.kt`, `src/index.ts`); test `modules/sms-ingest/src/index.test.ts` (JS side, module mocked).

**Interfaces:**
- Consumes: `TemplateEngine` (Task 8); outcome of Task 2.
- Produces (JS): `drain(): Promise<RawSms[]>` (returns and clears the native queue), `backfill(days: number, senderPatterns: string[]): Promise<RawSms[]>` (reads the inbox, filtered to the configured senders, last `days` days; requires `READ_SMS`), `setTemplates(json: string): void` (stored in app files; used in preference to the bundled copy), `hasPermission(): Promise<{receive: boolean; read: boolean}>`, `requestPermissions()`. `RawSms = { sender: string; body: string; receivedAt: number }`.

- [ ] **Step 1: Failing JS test:** `drain` returns queued items once then `[]`; `backfill(7, ['IDFCFB'])` passes both args through. Kotlin side: JUnit for `SmsQueue` (append, drain-clears, survives process restart using a temp store) and for sender filtering (only `*IDFCFB*` kept; others never stored).
- [ ] **Step 2:** Implement: receiver drops senders not matching the configured patterns *before* storing anything, drops OTPs, stores raw `{sender, body, ts}`, and if `TemplateEngine.parse` succeeds posts a notification such as "₹12,932 credited to IDFC …6507. Tap to classify" (amount from the engine; no body text); on parse failure posts nothing. Notification tap deep-links to the Inbox.
- [ ] **Step 3:** Run JS and JUnit tests; PASS. **Step 4:** On the phone, with the app swiped away, deliver a real IDFC-format SMS; notification appears; opening the app `drain()` returns it. Record in `docs/spike-report.md`.
- [ ] **Step 5:** Commit `feat: native sms receiver, queue and notification`.

### Task 10: ERPNext client and login

**Files:** Create `src/erp/client.ts`, `src/erp/auth.ts`; tests `client.test.ts`, `auth.test.ts` (mocked `fetch`).

**Interfaces:**
- Produces:
  - `class ErpClient { constructor(opts: {siteUrl: string; apiKey: string; apiSecret: string; fetchImpl?: typeof fetch}); get<T>(path: string, params?: Record<string, unknown>): Promise<T>; post<T>(path: string, body: unknown): Promise<T>; delete(path: string): Promise<void>; call<T>(method: string, args?: Record<string, unknown>): Promise<T> }` sending `Authorization: token key:secret`.
  - Errors: `ErpAuthError` (401/403, carries `missingRole?`), `ErpValidationError` (417/422/400, carries `message`, `missingFields?: string[]`, `closedPeriod?: boolean`), `ErpNetworkError`.
  - `normalizeSiteUrl(input: string, opts: {allowHttp: boolean}): string` (adds `https://`, strips path, rejects `http:` unless allowed).
  - `login(args: {siteUrl: string; username: string; password: string; confirmRotate: () => Promise<boolean>}): Promise<Session>` where `Session = {siteUrl: string; apiKey: string; apiSecret: string; user: string; roles: string[]}`; throws `TwoFactorRequired` if the login response asks for it.
- Method names/shapes come from `docs/spike-report.md` (Task 3).

- [ ] **Step 1: Failing tests:** `normalizeSiteUrl('stageatom.onebook.app/app')` → `https://stageatom.onebook.app`; `http://x` throws unless `allowHttp`; a 403 body naming a role yields `ErpAuthError.missingRole`; a 417 body with "Mandatory fields required … Gender" yields `missingFields:['Gender']`; a posting-date-in-closed-period message yields `closedPeriod:true`; `login` calls `confirmRotate` only when the user already has an `api_key`, and does not call `generate_keys` if it returns false (Review Focus 4, 5); the password string never appears in anything written to the injected secure-store mock.
- [ ] **Step 2–4:** run/fail, implement, run/pass. **Step 5:** commit `feat: erpnext client, errors and login`.

### Task 11: ERPNext document operations

**Files:** Create `src/erp/docs.ts`, `src/erp/reports.ts`; tests `docs.test.ts` (mocked) and `docs.stage.test.ts` (runs only when `ONEBOOK_STAGE_*` is set).

**Interfaces:**
- Consumes: `ErpClient`.
- Produces: `listCompanies(c): Promise<{name: string; currency: string}[]>`; `listBankAccounts(c, company): Promise<{name: string; glAccount: string; bankAccountNo: string | null; isCompanyAccount: boolean}[]>`; `PartyRef = {doctype: 'Customer'|'Supplier'|'Employee'; name: string}`; `searchParties(c, doctype, q): Promise<PartyRef[]>`; `createParty(c, doctype, fields): Promise<PartyRef>`; `getRequiredFields(c, doctype): Promise<{fieldname: string; label: string; fieldtype: string}[]>`; `listOpenInvoices(c, partyType, party): Promise<{doctype: string; name: string; outstandingMinor: number; dueDate: string}[]>`; `createDraft(c, doctype: 'Payment Entry'|'Journal Entry', body): Promise<{name: string}>`; `findDraftByUtr(c, utr): Promise<{doctype: string; name: string; docstatus: number} | null>` (Payment Entry by `reference_no`, Journal Entry by `cheque_no`); `deleteDraft(c, doctype, name): Promise<void>` (refuses if `docstatus != 0`); `getDocStatuses(c, refs): Promise<Record<string, number>>`; `getBankBalance(c, glAccount, company): Promise<number>`; `getReceivablesPayables(c, company): Promise<{receivableMinor: number; payableMinor: number}>` (via the report, never a sum of invoices, spec §11).

- [ ] **Step 1: Failing tests (mocked):** `findDraftByUtr` queries both doctypes and returns the first hit; `deleteDraft` throws `NotDraftError` when status is 1; `createParty('Customer', …)` merges required-field values supplied by the caller and throws `ErpValidationError` with `missingFields` when the server reports them (Review Focus 4). Stage test: create → find by UTR → delete a draft Journal Entry; skipped without env.
- [ ] **Step 2–4:** run/fail, implement, run/pass (stage test run once manually). **Step 5:** commit `feat: erpnext document operations`.

### Task 12: Action planner

**Files:** Create `src/core/plan.ts`; test `src/core/plan.test.ts`.

**Interfaces:**
- Consumes: `PendingTxn`, `AccountMapping`.
- Produces:

```ts
export type ActionChoice =
 | {type:'customer_advance'; party: PartyRef}
 | {type:'supplier_payment'; party: PartyRef}
 | {type:'against_invoice'; party: PartyRef; invoices: {doctype:'Sales Invoice'|'Purchase Invoice'; name: string; allocatedMinor: number}[]}
 | {type:'bill_paid_by_card'; party: PartyRef; invoice: {name: string; allocatedMinor: number}}
 | {type:'expense'; expenseAccount: string; party?: PartyRef}
 | {type:'salary'; party: PartyRef}
 | {type:'other_income'; incomeAccount: string}
 | {type:'transfer'; toAccount: AccountMapping}
 | {type:'personal'} | {type:'ignore'};
export interface PlanContext { company: string; account: AccountMapping; drawingsAccount: string; inrAmountMinor?: number }
export interface PlanStep { kind: 'create_party'|'create_doc'; doctype: string; body: Record<string, unknown> }
export interface ActionPlan { steps: PlanStep[]; summary: string[]; needsInrAmount: boolean }
export function planAction(txn: PendingTxn, choice: ActionChoice, ctx: PlanContext): ActionPlan
```

- [ ] **Step 1: Failing tests**, one per spec §9 row, asserting `doctype`, `payment_type`/accounts, `reference_no`/`cheque_no` = `txn.utr` (or a derived `rawHash` when UTR is null), `reference_date` = `occurredOn`, amount: customer advance → Payment Entry Receive, no references; expense on card → Journal Entry debit `expenseAccount` / credit `ctx.account.glAccount`; `bill_paid_by_card` → Payment Entry Pay with `paid_from` = card GL (or the Journal Entry shape recorded in Task 3 if rejected); `transfer` current→card → Internal Transfer Payment Entry; `personal` → Journal Entry against `drawingsAccount`; `ignore` → `steps: []`. Foreign-currency card spend without `inrAmountMinor` → `needsInrAmount: true` and no steps; with it, the document amount is the INR value and the USD amount appears in `remarks`. `summary` is the plain-language list shown on the confirm screen.
- [ ] **Step 2–4:** run/fail, implement, run/pass. **Step 5:** commit `feat: action planner`.

### Task 13: Outbox runner with idempotency and compensation

**Files:** Create `src/outbox/runner.ts`; test `src/outbox/runner.test.ts` with a fake ERP.

**Interfaces:**
- Consumes: `ActionPlan`, `Repo`, `docs.ts`.
- Produces: `runPlan(txnId: string, plan: ActionPlan, deps: {repo: Repo; erp: ErpOps}): Promise<RunResult>`; `RunResult = {status:'created'; docs: {doctype: string; name: string}[]} | {status:'failed'; error: ErpValidationError|ErpNetworkError; retryable: boolean} | {status:'needs_login'}`. `ErpOps` is the subset of Task 11 functions used.

- [ ] **Step 1: Failing tests:** (a) before creating, `findDraftByUtr` hit → returns `created` with the existing doc and creates nothing (idempotent retry); (b) step 1 creates a party, step 2 throws `ErpValidationError` → the party step's progress is persisted and a retry reuses the party instead of creating a second (Review Focus 3); (c) unrecoverable validation failure after documents were created → those drafts are deleted, state returns to `new`, `error` holds a readable message with `missingFields`/`closedPeriod` surfaced (Review Focus 4); (d) `ErpAuthError` → `needs_login`, outbox item kept (Review Focus 5); (e) network error → `retryable: true`, item kept.
- [ ] **Step 2–4:** run/fail, implement, run/pass. **Step 5:** commit `feat: outbox runner with compensation`.

### Task 14: Suggestions and learned rules

**Files:** Create `src/core/suggest.ts`; test `src/core/suggest.test.ts`.

**Interfaces:**
- Produces: `suggest(txn: PendingTxn, rules: Rule[], openInvoices: OpenInvoice[], parties: PartyRef[]): Suggestion[]` ordered best first, `Suggestion = {choice: Partial<ActionChoice>; reason: 'rule'|'utr'|'exact_invoice_amount'|'name_match'; confidence: number}`; `learnRule(txn: PendingTxn, choice: ActionChoice, existing: Rule[]): Rule[]` (key = normalised counterparty, else normalised merchant).

- [ ] **Step 1: Failing tests:** a saved rule for merchant `FACEBOOK` yields an `expense` suggestion with its account; a debit whose amount equals exactly one open Purchase Invoice's outstanding yields `exact_invoice_amount`; counterparty "ACME TEST TRADERS" fuzzy-matches customer "Acme Test Traders Pvt Ltd" as `name_match`; nothing is ever returned with an auto-post flag (phase 1, §7.8); `learnRule` increments `hits` on repeat. **Steps 2–5** as usual; commit `feat: suggestions and rules`.

### Task 15: Ingestion pipeline and template updates

**Files:** Create `src/ingest/pipeline.ts`, `src/ingest/templates.ts`; tests alongside.

**Interfaces:**
- Consumes: native `drain/backfill/setTemplates`, `parseSms`, `correlate`, `Repo`.
- Produces: `ingest(deps): Promise<{inserted: number; enriched: number; duplicates: number; ignored: number}>` run on app foreground and after setup; `ensureBackfill(deps)` runs once after setup and then on each app open for the last 7 days; `refreshTemplates(deps: {url: string; fetchImpl?: typeof fetch}): Promise<'updated'|'unchanged'|'failed'>` (validates JSON shape and every regex compiles before calling `setTemplates`; keeps the bundled copy on any failure).

- [ ] **Step 1: Failing tests:** draining the same 3 messages twice yields 3 inserts then 0 (Review Focus 2); a backfill overlapping live items yields only duplicates; an unmapped account (sender matches but last-4 not in any mapping) is not stored and sets a one-time "unrecognised account" flag (spec §11); `refreshTemplates` with a template whose regex does not compile returns `failed` and leaves the old set; a higher `version` is applied.
- [ ] **Step 2–4:** run/fail, implement, run/pass. **Step 5:** commit `feat: ingestion pipeline and template refresh`.

### Task 16: Screens: login, setup wizard, permissions and OEM onboarding

**Files:** Create `app/(auth)/login.tsx`, `app/(setup)/{company,accounts,defaults,permissions}.tsx`, `src/state/session.ts`; tests with React Native Testing Library.

**Interfaces:** Consumes `login`, `listCompanies/listBankAccounts` (add to `docs.ts` if missing), `Repo.saveMapping`, native permissions. Produces a completed `settings` row (`company`, `drawingsAccount`, `defaultExpenseAccount`, `setupDone`).

- [ ] **Step 1: Failing tests:** login shows the rotate-key warning copy and a "use a dedicated user" hint before `generate_keys` when the user already has keys; a 2FA response shows an actionable message; the accounts step lets one ERPNext card account take two last-4 values; the permissions step shows the in-app SMS disclosure *before* requesting permissions, and the OEM battery instructions recorded in Task 2.
- [ ] **Step 2–4:** run/fail, implement (use `frontend-design` for visual direction, keeping kit components behind `src/ui/`), run/pass. **Step 5:** commit `feat: login and setup screens`.

### Task 17: Screens: inbox, transaction, action flow, result

**Files:** Create `app/(tabs)/inbox.tsx`, `app/txn/[id].tsx`, `src/ui/ActionSheet.tsx`; tests.

**Interfaces:** Consumes `suggest`, `planAction`, `runPlan`, `docs.ts` search functions. Produces the confirm screen listing `ActionPlan.summary` and a result screen with document names.

- [ ] **Step 1: Failing tests:** credit shows *Customer advance · Against invoice · Other income · Transfer · Personal · Ignore*; debit shows its own set (spec §8); foreign-currency card spend forces the INR-amount field (or "leave for accountant"); the confirm button is disabled until the plan summary has rendered; a `needs_login` result routes to login and keeps the item in the Inbox; a failure shows `missingFields` with an "open in ERPNext" link.
- [ ] **Step 2–4:** run/fail, implement, run/pass. **Step 5:** commit `feat: inbox and action flow screens`.

### Task 18: Activity, submit-status poller, Undo

**Files:** Create `app/(tabs)/activity.tsx`, `src/ingest/statusPoller.ts`; tests.

**Interfaces:** Produces `pollStatuses(deps): Promise<number>` (updates `createdDocs[].docstatus` via `getDocStatuses`, flips item to `submitted` when all docs are `1`) and `undo(txnId, deps): Promise<void>` (only while every doc is `docstatus 0`; deletes drafts, returns the item to `new`).

- [ ] **Step 1: Failing tests:** poll marks `submitted` when status becomes 1; Undo refuses after submission with a message pointing to ERPNext; Undo after partial failure still restores the Inbox item. **Steps 2–5** as usual; commit `feat: activity, status polling and undo`.

### Task 19: Home dashboard and trust rules

**Files:** Create `app/(tabs)/home.tsx`, `src/core/trust.ts`; tests.

**Interfaces:** Produces `buildTrust(input: {lastSyncedAt: number | null; now: number; unclassifiedCount: number; pendingDrafts: {count: number; totalMinor: number}; computedBankBalanceMinor: number | null; smsBalanceMinor: number | null}): {incomplete: boolean; reasons: string[]; mismatch: boolean}`.

- [ ] **Step 1: Failing tests:** stale sync (> 24 h) → `incomplete` with reason; unclassified items → `incomplete`; only drafts pending → not incomplete but drafts count/value present; SMS balance differing from computed → `mismatch`. Screen test: figures render with "last synced" and "pending drafts" beside them.
- [ ] **Step 2–5:** as usual; commit `feat: dashboard with trust indicators`.

### Task 20: Hardening and pilot release

**Files:** Create `docs/play-sms-declaration.md`; modify `app.json`, EAS config; test `src/erp/https.test.ts`.

- [ ] **Step 1:** Draft the Play Console SMS permission declaration text (core functionality, configured senders only, parsed on device, no raw SMS leaves the device) and the in-app prominent disclosure, matching Task 16 copy.
- [ ] **Step 2:** Sentry with `beforeSend` scrubbing: a test feeds an event containing an amount, a UTR and a body snippet and asserts none survive. Release builds reject `http:` site URLs (test).
- [ ] **Step 3:** EAS Build to the internal testing track; configure EAS Update channel; document how to ship a template-only update (CDN JSON) versus a code update.
- [ ] **Step 4:** Pilot checklist run on stage with the real phone: the §17 success criteria that can be measured (parse rate over fixtures; no duplicates over a 48 h run; every document traceable to a confirmed action). Record in `docs/spike-report.md`.
- [ ] **Step 5:** Commit `chore: release hardening and pilot checklist`.

---

## Self-review notes

- **Spec coverage:** §3 non-goals honoured (no submit, no Bank Transaction, no AI); §7.1 → T10/T16; §7.2 → T16; §7.3 → T2/T8/T9/T15; §7.4 → T6/T15; §7.5–7 → T14/T17; §7.8 → T14; §7.9 → T19; §7.10 → T18; §9 → T12; §10 → T15/T17; §11 → T3/T10/T11; §12 → T7; §13 → T13; §14 → T19; §15 → T9/T10/T20; §16 milestones → T1–T3 (0), T16 (1), T4–T9/T15 (2), T10–T14/T17–T18 (3), T19 (4), T20 (5); §17A → T4–T6, T12, T16.
- **Decisions made by the plan (my calls):** separate git repo inside `autoledger/`; one shared JSON template file driving both TypeScript and Kotlin engines (the receiver only needs amount/direction, the full parse happens in TypeScript when the app opens); the receiver stores raw text only until the app drains it, then it is purged; NativeWind v4 first with a Paper fallback; thin `fetch` client by default instead of `frappe-js-sdk`.
- **Order and parallelism:** T2 and T3 are independent and gate everything; T4 → T5 → T6; T8/T9 depend on T4/T5 and T2; T10–T14 depend on T3 and can run in parallel with T8/T9; UI tasks T16–T19 come last.
