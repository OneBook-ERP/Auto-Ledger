# AutoLedger (working title): Design Specification

Date: 2026-11-08
Status: Draft for approval
Marked **[Your call]** = decided by the product owner. **[My call]** = decided by the author as a sensible default; please review.

---

## 1. Intent

A mobile companion app for OneBook (ERPNext) customers that turns bank/credit-card SMS alerts into accounting entries within seconds of the money moving.

SMEs moving off Tally/Zoho suffer **reconciliation lag**: a customer pays an advance or a founder swipes a card for an AWS bill, and the books learn about it days later. Receivables, payables and bank balances are stale in the meantime. The earliest available signal of a transaction is the bank SMS. The app captures that signal, asks the user one small question ("what was this?"), and creates the correct draft ERPNext records.

The product is an **inbox of unclassified money movements with one-tap resolution**, plus a small live dashboard (bank balances, AR, AP, unreconciled count).

## 2. Goals

1. Capture bank and card SMS reliably, in the background, on Android.
2. Resolve each transaction in a few taps by creating the right ERPNext draft document (Payment Entry or Journal Entry) carrying the UTR/reference and date, so the accountant can submit it and do bank reconciliation in ERPNext.
3. Work on **vanilla ERPNext** with no custom app and no server of ours.
4. Show an accurate, trustworthy mini-MIS: bank balances, AR, AP, unreconciled count, last-synced time.
5. Learn from user answers so repeat transactions need fewer taps.

## 3. Non-goals (phase 1)

- AI/LLM classification. Matching is deterministic.
- Email/PDF statement parsing, Account Aggregator, iOS.
- Submitting documents. **[Your call]** All created documents remain **drafts** for the accountant to review and submit.
- **[Your call]** Bank Transaction creation and any bank reconciliation by the app are **phase 2**. In phase 1 the accountant does bank reconciliation in ERPNext. The app never creates or links Bank Transactions.
- Generating Sales Orders. An advance is recorded as an unallocated Payment Entry against a party.
- TDS deductions, multiple companies per login, GST return workflows, and full multi-currency accounting. Foreign-currency card spends are handled by asking the user for the INR amount (see §17A).
- Syncing learned rules across devices. **[Your call]** Rules live on one device.
- Any backend, queue or push infrastructure operated by us.

## 4. Anti-goals (a failure even if it "works")

- A wrong entry posted silently. The user must always see what will be created before it is created.
- Notification spam that leads users to mute the app.
- Raw SMS content leaving the device.
- Requiring any change to the customer's ERPNext site (no installed app, no schema changes).
- A dashboard that looks authoritative while data is incomplete.

## 5. Constraints

- **Vanilla ERPNext only. [Your call]** The pilot site (atom.onebook.app) runs **ERPNext 16.53 / Frappe 16.54 with India Compliance 16.11** (checked read-only on 2026-11-08). Target v15 and v16 **[My call]**; verify method names and behaviour on v16 in the spike. GST fields on Customer/Supplier will therefore be present on the pilot.
- **Login in app with site URL, username and password. [Your call]**
- Android first. iOS is optional and later. **[Your call]**
- INR, single company per login (phase 1).
- Google Play requires an SMS permission declaration. A Play developer account exists. **[Your call]** Start the declaration early.
- The logged-in user needs roles sufficient to create the documents (e.g. Accounts User). The app checks on login and states what is missing.

## 6. Technology decisions

**[Your call]** (after comparison): React Native with Expo and TypeScript, with a local Kotlin module for SMS.

| Concern | Choice |
|---|---|
| App framework | Expo (dev client + prebuild), TypeScript, Expo Router |
| SMS capture | Local Expo module in Kotlin: broadcast receiver, OTP filter, per-bank parsers, writes to local storage and posts the notification itself. Does **not** rely on headless JS. |
| Local storage | expo-sqlite (pending queue, rules, processed log, account mappings) |
| Server state | TanStack Query |
| UI state | Zustand **[My call]** |
| ERPNext client | `frappe-js-sdk` with API-key token auth, or a thin typed client of our own. Decide in the spike. `frappe-react-sdk` is not used. |
| Secrets | API key/secret in secure storage (Android Keystore via expo-secure-store) |
| Parser updates | Static JSON hosted on a CDN/GitHub, fetched by the app; bundled copy as fallback |
| Logic updates | EAS Update (OTA) for JS; EAS Build for binaries |
| Fallback | Native Kotlin + Compose if the spike fails |

## 7. Features (phase 1)

1. Login (site URL, username, password) → API key/secret stored, password discarded.
2. Setup wizard: choose company; map each ERPNext **Bank Account** (bank or card) to SMS sender IDs and **one or more** last-4 digits (the pilot has two cards, ending 3455 and 8129, that map to one ERPNext card account); choose accounts for Personal/Drawings and a default expense account. **[My call]**
3. **[My call]** Setup-time and app-open backfill: scan the SMS inbox for the last 7 days, configured senders only, to recover messages missed while the OS killed the receiver. This requires `READ_SMS` in addition to `RECEIVE_SMS`, so the Play declaration must cover both. Onboarding screens guide the user through OEM battery/autostart settings. The spike bar for the receiver is: fires with the app swiped away and the screen off, on one Xiaomi and one Samsung device.
   SMS capture with OTP and promo filtering, and parsing into: direction, amount, date, account last-4, reference/UTR, counterparty text, available balance if present.
4. De-duplication (local, and against existing Payment/Journal Entries carrying the same UTR).
5. Inbox of pending transactions, with local notifications.
6. Match suggestions: reference numbers, learned rules, exact amount against open invoices, fuzzy party name.
7. Resolution actions (see §9).
8. Learned rules (counterparty/VPA → party or account), stored locally, applied as suggestions, never silently auto-posted in phase 1. **[My call]**
9. Home dashboard (bank balances, AR, AP, unreconciled count, last synced).
10. Activity log with Undo.
11. Settings: accounts, rules, parser version, logout.

## 8. Navigation and screen flow

```
Login ─▶ Setup (company, bank/card mapping, default accounts) ─▶ Main shell
Main shell (bottom tabs)
 ├ Home      ─▶ tap bank / AR / AP ─▶ list ─▶ document detail (read-only)
 ├ Inbox     ─▶ Transaction ─▶ Action sheet ─▶ Party step ─▶ Confirm ─▶ Result
 ├ Activity  ─▶ processed item ─▶ Undo
 └ Settings  (accounts, rules, parsers, logout)
Notification tap ─▶ Transaction directly
```

Core journey, unmapped credit:
1. Notification: "₹50,000 credited to HDFC …1234. Tap to classify."
2. Transaction screen: amount, date, reference, counterparty text, suggested match if any.
3. Action sheet (credit): *Customer advance · Against invoice · Other income · Transfer · Personal · Ignore*. (debit): *Supplier payment · Against bill · Expense · Salary/Employee · Transfer · Personal · Ignore*.
4. Party step: search existing or create new (name, group, optional GSTIN **only if the site has that field**).
5. Confirm screen: lists every document that will be created, in plain language.
6. Result: links to created drafts, Undo.

Visual design is left to the builder; run `frontend-design` during planning.

## 9. Resolution actions and what they create (all drafts)

| Action | ERPNext result |
|---|---|
| Customer advance | Payment Entry (Receive), party = Customer, unallocated, bank account = mapped account |
| Against invoice | Payment Entry (Receive/Pay) with a reference row to the chosen open invoice(s); partial amount allowed |
| Supplier payment / advance | Payment Entry (Pay), party = Supplier |
| Expense with no bill (e.g. AWS on card) | Journal Entry: debit expense account, credit the bank/card liability account. Merchant→expense account saved as a rule. **[Your call]** This is the main card-spend path |
| Bill/invoice paid by card | Payment Entry (Pay) against the Purchase Invoice with `paid_from` = the card's liability account, if the spike shows ERPNext accepts it; otherwise a Journal Entry with a party row referencing the invoice **[My call]** |
| Salary / Employee | Payment Entry (Pay) with party type Employee |
| Other income | Journal Entry: debit bank, credit chosen income account |
| Transfer between own accounts, including paying the credit-card bill from the current account | Payment Entry (Internal Transfer) from the current account to the card's liability account **[Your call]**. No card-side "payment received" SMS was found in the pilot data (§17A), so the app does not wait for a counter-leg |
| Personal / Drawings | Journal Entry against the configured Drawings/Director-loan account **[My call]** |
| Ignore | Nothing is created in ERPNext; remembered locally so it is not re-prompted |

Every document stores the UTR/reference number (Payment Entry `reference_no`, Journal Entry `cheque_no`) and the transaction date as reference date, so the accountant can match it against the bank statement. The accountant submits the drafts and performs bank reconciliation in ERPNext's standard Bank Reconciliation Tool. The app does not touch reconciliation in phase 1.

**[My call] After creation** the item leaves the Inbox and appears in Activity under "Awaiting accountant". The app periodically checks `docstatus`; once submitted the item is marked `submitted`. Undo (delete the draft) is offered only while `docstatus = 0`; after submission the user is pointed to ERPNext.

## 10. Data flow

```
SMS ─▶ native receiver ─▶ OTP filter + parser ─▶ SQLite (pending) ─▶ local notification
                                  │
        dedupe (local hash; before creating, look up existing Payment/Journal Entry by UTR)
                                  ▼
                    Inbox shows it (nothing sent to ERPNext yet)
                                  ▼
         user action ─▶ create Party / Payment Entry / Journal Entry (draft, with UTR)
                                  ▼
          Activity "Awaiting accountant" ─▶ update local rules ─▶ refresh MIS
                                  ▼
        accountant submits drafts and reconciles in ERPNext (outside the app)
```

Offline: pending items and user actions queue locally and replay when connectivity returns, each with an idempotency key (the transaction's reference/hash).

## 11. API map (all standard ERPNext; no new APIs)

Method names and parameters must be verified against the target version in the spike.

| Step | API |
|---|---|
| Login | `POST /api/method/login`; then `frappe.core.doctype.user.user.generate_keys` for key/secret; handle 2FA response. **[My call]** `generate_keys` rotates any existing secret, which would break other integrations using that user. If the user already has an `api_key`, the app warns before proceeding, recommends signing in with a dedicated "AutoLedger" user, and only regenerates after explicit confirmation. |
| Session/logout | `frappe.auth.get_logged_user`, `/api/method/logout` |
| Company, defaults | `/api/resource/Company`, Global Defaults |
| Bank accounts | `/api/resource/Bank Account`. **[My call]** The setup-wizard mapping (sender ID + last-4 → Bank Account) is the only source of truth; `bank_account_no` is used only to suggest defaults. An SMS from an unmapped account is not stored; the app shows a one-time "Unrecognised account ending 5678, add it?" prompt. |
| Dedupe | `GET /api/resource/Payment Entry` filtered by `reference_no`; `Journal Entry` filtered by `cheque_no` (UTR stored there) |
| Party search/create | `/api/resource/Customer`, `Supplier`, `Employee` |
| Open invoices | `/api/resource/Sales Invoice`, `Purchase Invoice` with `outstanding_amount > 0` |
| Payments / expense | `/api/resource/Payment Entry`, `/api/resource/Journal Entry` (left as draft) |
| Submit-status check | `GET /api/resource/Payment Entry` / `Journal Entry` fields `docstatus` |
| Undo | Delete the draft voucher (only while `docstatus = 0`) |
| Bank balance | `erpnext.accounts.utils.get_balance_on` |
| AR / AP | Accounts Receivable / Payable Summary via `frappe.desk.query_report.run`. **Do not** sum invoice outstanding: it misses unallocated advances |
| Doctype metadata | `frappe.desk.form.load.getdoctype` (to adapt forms and detect required/custom fields) |

## 12. Local data model (SQLite) **[My call]**

- `account_mapping`: bank_account (ERPNext name), sender_ids, last4, kind (bank/card), gl_account.
- `pending_txn`: id/hash, raw_ref, direction, amount, date, last4, counterparty_text, balance, state (new/queued/created/submitted/ignored/failed), created_docs[] (doctype + name + docstatus), error.
- `rule`: match_key (VPA / merchant / name pattern), action, party or account, hits, last_used.
- `outbox`: queued API operations with idempotency key and step progress (for compensation).
- `settings`: company, parser_version, last_sync.

Raw SMS text is never sent to ERPNext or any server. Only parsed fields are used. Store the minimum raw text locally and purge it after resolution. **[My call]**

## 13. Failure handling (no atomic transactions over REST)

- Each multi-step action is a sequence recorded in `outbox` with progress. On failure the app retries idempotently; if a step is unrecoverable it **compensates** (deletes created drafts) and surfaces the item back in the Inbox with an error.
- Duplicate protection: local hash + pre-insert lookup of Payment/Journal Entry by UTR. Known limitation: two devices racing can still duplicate; documented.
- Permission errors surface as plain-language messages naming the missing role.
- Unknown required fields on a doctype (customised sites): the app reads metadata and prompts for them or fails safely with a "complete in ERPNext" link.

## 14. Dashboard trust rules

Show "last synced", "N unclassified" (items still in the Inbox) and "N awaiting accountant" (drafts not yet submitted) next to every figure. If sync is stale (> a threshold **[My call]** 24h) or the Inbox has unclassified items, the figures are labelled "may be incomplete". Items that are merely awaiting accountant submit do not trigger that label, but are shown separately because the figures will change when they are submitted. **Draft documents do not post to the ledger**, so bank balance, AR and AP exclude them until the accountant submits; the dashboard therefore shows the count and total value of pending drafts next to those figures. Compare the SMS "available balance" to the computed bank balance and flag a mismatch.

## 15. Security and privacy

- Parse on the device; OTP and promotional messages are discarded before storage.
- API key/secret in Android Keystore-backed secure storage; the password is never stored.
- HTTPS required for the site URL; reject plain HTTP except in debug builds.
- Only senders matching configured bank IDs are read; other SMS are ignored. This also supports the Play declaration and DPDP consent. A clear in-app disclosure before permission is requested.
- Minimal logging; no financial data in crash reports.

## 16. Milestones

0. **Spike (1–2 days).** (a) Kotlin receiver fires with the app swiped away on Xiaomi/Samsung. (b) Login → key/secret → create a draft Payment Entry against the pilot ERPNext. (c) Create a draft Payment Entry (advance) and a draft Journal Entry carrying the UTR, then look them up by reference for dedupe. (d) Confirm the SDK works in the Expo dev client. (e) Confirm Payment Entry accepts the credit-card liability account as `paid_from` for a bill paid by card; if not, use a Journal Entry with party and invoice reference rows. Also confirm an Internal Transfer Payment Entry works from the current account to the card liability account. Fallback to native Kotlin if (a) or (b) fail.
1. Login, setup wizard, account mapping.
2. Capture, parsers (pilot banks), dedupe, inbox, notifications.
3. Resolution actions, outbox and compensation, Undo.
4. Dashboard and trust indicators.
5. Hardening, Play SMS declaration, internal-test rollout to pilot customers.

## 17. Success criteria

- ≥ 95% of pilot-bank SMS are parsed correctly (measured on collected samples).
- A typical credit is resolved in ≤ 4 taps.
- No duplicate Payment/Journal Entries in the pilot.
- Zero silently created documents: every document traces to a user-confirmed action.
- Pilot accountants can review and submit the drafts, and reconcile them against the bank statement in standard ERPNext, without clean-up.

## 17A. Findings from the pilot's real IDFC SMS (read from the pilot phone, 2026-11-08)

Source: 991 non-OTP messages from IDFC First senders (`*-IDFCFB-S`), March 2024 to November 2026. Sender prefixes vary (VM-, AX-, CP-, AD-, JM-, JK-, JD-, VD-, VA-), so match on the `IDFCFB` core. Samples are kept outside the repo until redacted. Parser requirements that follow:

1. **Parse by template whitelist, not by sender.** About 25% of IDFC messages are marketing, KYC, limit alerts ("used 80% of limit"), eStatement notices or application reminders. Only recognised money templates create Inbox items.
2. **Current account has two formats.**
   - Short: "A/C … is credited with / debited by INR x on dd/mm/yy hh:mm. New Bal" has **no counterparty and no UTR**, so credits will often need "who paid?".
   - Long: "A/c …6507 has been credited with / debited by Rs. x … Info: NEFT/<bank>/<NAME>" has the name (and UTR on debits).
3. **One outgoing payment can produce two SMS**: the debit, then "Your beneficiary <NAME> has received Rs x via NEFT UTR …" (144 of these). The confirmation carries the beneficiary name and UTR, so it should enrich the pending debit (match on amount and time) rather than create a second Inbox item.
4. **One card charge can produce three SMS**: a "will be deducted" notice for standing instructions, a "paid" notice, and a "Transaction Successful! … spent" message. "Will be deducted" notices must **not** create items. The other two need correlation by merchant, amount and date, since there is no transaction ID.
5. **Two cards, one ERPNext account.** Last-4 digits 3455 and 8129 both belong to the IndiGo dual card. The mapping must allow several last-4 values per Bank Account.
6. **Foreign-currency card spends** (7 so far, for example USD 100 to ANTHROPIC) show the foreign amount; the INR billed amount is **not in the SMS** (only the remaining limit). The Inbox asks the user for the INR amount, or lets them leave it for the accountant to correct from the statement.
7. **No card-side "payment received" SMS** appeared. Paying the card bill from the current account appears only as a current-account debit.
8. **UPI alerts are almost absent** from IDFC messages, so UPI is not a phase-1 focus for IDFC. Other banks on the phone (ICICI, HDFC, SBI Card, RBL) are candidates for later parsers.
9. Merchants repeat heavily (Facebook, Google Ads, Adobe, Meta), so merchant-to-expense-account rules will pay off quickly.

## 18. Left to the builder

Screen visuals and copy, exact parser implementation, folder structure, test strategy (unit tests for parsers, matcher and outbox are expected), error-message wording, and library versions.

## 19. Inputs needed from the product owner

- Pilot banks and cards, with real (redacted) SMS samples for each.
- Pilot customer ERPNext version, hosting type, and whether India Compliance is installed.
- Whether pilot sites enforce two-factor login.
