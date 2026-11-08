# Pilot checklist (spec section 17)

Run on the STAGE site (`https://stageatom.onebook.app`) with the pilot phone. Never write real SMS text, phone numbers, account numbers or credentials into this file or the spike report; record counts, dates and document names only. Record results in `docs/spike-report.md` (new section "D. Pilot run") when done.

Success criteria from `docs/superpowers/specs/2026-11-08-autoledger-design.md` section 17, and how each is measured:

| # | Criterion | Measure | Target |
|---|---|---|---|
| i | >= 95% of pilot-bank SMS parsed correctly | `npx tsx scripts/pilot-parse-rate.ts` (fixtures) plus the on-phone sample in 1b | >= 95% |
| ii | No duplicate Payment/Journal Entries | `scripts/pilot-duplicates.ts` after the 48 h run | 0 duplicate references |
| iii | Zero silently created documents | manual trace, section 3 | every document traced |
| iv | Accountant can review, submit, reconcile without clean-up | tick list, section 4 | all ticked |
| v | Typical credit resolved in <= 4 taps | counted on the phone, section 5 | <= 4 |

## 1. Parse rate

### 1a. Fixtures (automated, no network)

```
npx tsx scripts/pilot-parse-rate.ts
```

Loads `fixtures/sms/idfc.json` and the bundled `templates/idfc.json` through `parseSms` and prints the count per expected kind, then the percentage of money-kind fixtures (`ca_credit`, `ca_debit`, `neft_confirm`, `card_spend`, `card_si_paid`) whose parse equals every field the fixture lists, and how many non-money fixtures (OTP, SI notices, not-money, unknown) were dropped for the expected reason. Exit code 0 when >= 95%. Last run on 2026-11-09: 46/46 money fixtures (100%), 14/14 ignore fixtures. `npm test` also asserts the target (`scripts/pilotParseRate.test.ts`). [FILL IN: re-run date and result at pilot time]

Limit: the fixtures are the messages the templates were written against, so 100% there says the templates are not regressing, not that unseen messages parse. That is what 1b is for.

### 1b. Real messages on the phone (sample)

1. After the 48 h run, open the app Home/Inbox and note: items created from SMS, and the "unrecognised" count (money-like messages the parser did not understand).
2. Parse rate on the phone = items parsed / (items parsed + unrecognised). [FILL IN: where the unrecognised count is shown in the final UI, see Home]
3. For each unrecognised message: open the phone's Messages app, find it (sender contains IDFCFB, same day), copy the text into a **redacted** form (`npx tsx scripts/redact-sms.ts raw.json out.json`, raw file kept outside the repo), add it to `fixtures/sms/idfc.json`, and fix the template (`docs/release.md` section 3a).

| Date | Parsed | Unrecognised | Rate | Notes |
|---|---|---|---|---|
| [FILL IN] | | | | |

## 2. No duplicates over a 48 h run

Procedure: install the preview build on the pilot phone against the stage site; leave it running normally for 48 hours (phone on, SMS arriving, the app opened at least morning and evening); confirm and create drafts from the Inbox as usual. Include at least one of: a transaction confirmed twice quickly (double tap), an app kill during Create, flight mode during Create then retry.

After 48 hours, from a laptop (credentials in your shell environment from `.env.local`, never typed into a file):

```
set -a; source .env.local; set +a
npx tsx scripts/pilot-duplicates.ts --from YYYY-MM-DD --to YYYY-MM-DD --draft-days 2
```

The script is read-only (GET requests only) and refuses to run unless `ONEBOOK_STAGE_URL` is exactly `https://stageatom.onebook.app`. It prints, for Payment Entry `reference_no` and Journal Entry `cheque_no`, every reference used by more than one non-cancelled document in the creation range (exit code 1 if any), and lists drafts older than N days still at docstatus 0 (these are not errors: they are what the accountant has not reviewed yet; investigate any the Activity screen does not show). A duplicate that is only a bank-shared UTR on two genuinely different payments is a known limitation (pipeline.ts, "Real UTRs can be shared across txns"): check the two documents' amounts and dates before counting it a failure.

Daily log for the 48 h run:

| Day | Date | Phone on / app opened (times) | SMS received (bank, count) | Items in Inbox | Drafts created | Unrecognised | Duplicates found | Problems / notes |
|---|---|---|---|---|---|---|---|---|
| 0 (start) | | | | | | | | |
| 1 | | | | | | | | |
| 2 | | | | | | | | |
| End | | | | | | | | script run: yes/no |

## 3. Every document traces to a confirmed action

Manual procedure, for every draft created during the run (or a sample of at least 10 plus every draft of an unusual kind):

1. In ERPNext (stage), open the draft. Note: doctype and name, posting date, amount, and the reference (Payment Entry `reference_no` / Journal Entry `cheque_no`).
2. In the app, open Activity and find the row for it (title = counterparty or merchant, signed amount, date). The row lists the created documents. The reference shown on the transaction screen is the bank's UTR when the SMS carried one, otherwise the derived reference `AL-<number>` (`txnReference` in `src/core/plan.ts`; label "Reference" or "AutoLedger reference"). [VERIFY after the Task 17 screens are merged which screen shows it; this worktree predates them.] The two must be equal.
3. Find the SMS on the phone: Messages app, search the sender (contains `IDFCFB`) and the amount, or scroll to the posting date and time. The amount, date and (for UTR references) the UTR in the SMS must match the draft. An `AL-` reference cannot be reversed to a message: match by amount, date and time.
4. Confirm the Activity row exists because you tapped Create draft: nothing in the app creates documents without that tap (`runPlan` is called only from the Confirm screen with `userAction: true`). A draft in ERPNext that has no Activity row and no matching SMS is a failure; record it.
5. Reverse check: from the ERPNext list, filter Payment Entries and Journal Entries created in the range by the integration user (the API key's user); the count must equal the count of Activity rows with created documents.

| Document | Reference | Activity row found | SMS found | Match | Notes |
|---|---|---|---|---|---|
| [FILL IN] | | | | | |

## 4. Accountant review (tick list)

The accountant, in standard ERPNext on stage, without any help from the developer, for at least 5 drafts of different kinds (customer advance, supplier payment, expense journal, card spend, transfer):

- [ ] Each draft opens, has the right company, accounts, party and amount, and a readable reference.
- [ ] Submit works on every draft without editing it (or the only edits were optional remarks).
- [ ] Submitted Payment Entries appear in Bank Reconciliation Tool for the account and match the bank statement lines by amount/date/reference.
- [ ] Journal Entries (expenses, card spends) reconcile the same way.
- [ ] Customer advances can be allocated to a later invoice; supplier payments are visible against the supplier.
- [ ] No draft had to be deleted or recreated to get the books right (note any that did).
- [ ] After the accountant submits, the app Activity row shows "Submitted" and no longer offers Undo for it.
- [ ] Accountant sign-off: name [FILL IN], date [FILL IN].

## 5. Tap count for a typical credit

Typical credit: a customer pays money into the current account.

Counting from the Inbox screen, with the account already mapped, taps only (typing the search text is not a tap), on the build that contains the Task 17 screens:

With a remembered rule or an invoice-matched suggestion: (1) tap the Inbox row, (2) tap the suggestion card, (3) tap Create draft on "Check before creating". **3 taps.**

First time for a customer, no rule: (1) tap the Inbox row, (2) tap "Customer advance" (or "Payment against an invoice"), (3) tap the customer in the search results, (4) tap Continue, (5) tap Create draft. **5 taps**, one over the target. The target is met for repeat customers (after the first confirmation with "Remember this choice" on). Decision for the founder: accept this reading of the criterion, or drop the Continue tap by moving on directly when a search result is tapped (`app/txn/party.tsx`). Measure on the phone and record:

| Case | Taps counted | Pass |
|---|---|---|
| Repeat customer with rule | [FILL IN] | |
| First-time customer | [FILL IN] | |

## 6. On-device checks still owed from earlier reviews

| # | Check | Procedure | Owner | Status |
|---|---|---|---|---|
| 1 | Scenario 7: idle test of the production receiver | `docs/spike-report.md` C.2 #7: swipe the app away, screen off about 12 min, check `adb shell pidof app.onebook.autoledger` empty each minute, send a plain SMS, wake the phone | founder with controller (adb) | open (C.5: NOT RUN) |
| 2 | OTP drop on hardware | Send a real OTP-style SMS from a configured sender; confirm nothing in the queue (`run-as ... cat no_backup/sms-ingest/queue.json`) or Inbox. Use a bank OTP if a test OTP is held by the carrier | founder | open (C.5 #3 NOT VERIFIED) |
| 3 | Keyboard behaviour | Login and party-search fields: keyboard does not cover the field or the primary button on the pilot phone | founder | open |
| 4 | Dark mode | Walk setup, Inbox, Confirm, Activity, Home with system dark mode on and off | founder | open |
| 5 | TalkBack announcements | TalkBack on: Inbox row, Confirm summary, Create result and error banners are read in a sensible order | founder or accessibility reviewer | open |
| 6 | Site-switch flow | Sign out, log in to a different site: local entries tied to the old site are not shown or acted on (Activity "site guard") | founder | open |
| 7 | Settings "Grant SMS permission" | Deny at setup, finish anyway, then grant from Settings; new SMS then arrive | founder | open |
| 8 | "Bill paid by card" references path with a real submitted Purchase Invoice | Needs a submitted Purchase Invoice with outstanding > 0 on stage (spike B.14: not live-tested; invoices must not be submitted on stage by the app). Accountant submits one; create the draft through Inbox; check the references row | accountant | open |
| 9 | First-draft submit by the accountant | Section 4, first item | accountant | open |
| 10 | Rotate stage and prod credentials | Create new API key/secret for the integration users, update `.env.local` and the logged-in app (sign out, log in), revoke the old keys. Do this after the pilot because credentials were used in test sessions | founder | open |
| 11 | Delete the two cancelled test invoices on stage | Purchase Invoices `PINV-26-00029` and `PINV-26-00030` (spike report B.12). The pilot API key cannot delete them (403 on Payment Ledger Entry); a System Manager deletes them from the desk | stage administrator | open |

Update the Status column with date and initials when each is done.
