# AutoLedger: context, decisions and status

Last updated: 9 Nov 2026. This file is the memory of the project. Update it when a decision is made, a limitation is found or the status changes. The detailed build ledger (rulings R1 to R57, review notes) is local only in `.superpowers/sdd/2026-11-08-autoledger-phase1/progress.md` (git-ignored); the important parts are digested below.

## Product in one paragraph
A business owner's phone receives bank/card SMS. AutoLedger parses them on the device, shows each as one question in the Inbox ("what was this?"), and on the answer creates a DRAFT in ERPNext. Home shows bank balance, to receive, to pay, and drafts waiting for the accountant, each with a trust label. The accountant submits and reconciles in ERPNext. It must work on vanilla ERPNext with only whitelisted/REST APIs.

## Status (9 Nov 2026)
- Plan: `docs/superpowers/plans/2026-11-08-autoledger-phase1.md` (20 tasks) is fully implemented and merged on branch `phase1` (head is a merge of the UI polish pass). UI polish plan: `docs/superpowers/plans/2026-11-09-ui-polish.md` (U1 to U4 merged). Tests: about 1,234 Jest, 88 Kotlin JUnit, typecheck clean.
- Running on the user's Oppo phone as a development build against the stage site. Sign-in, setup, SMS backfill (1 week by default, user-chosen; routine app opens re-read only the last week or the days since the last read), Inbox, answer flow, Home, Activity and Settings work. One real draft (a Payment Entry) exists on stage from testing.
- Nothing is pushed to GitHub (see hard rules in `CLAUDE.md`).

## Next steps
1. Walk the answer flow on the device (detail, account picker, Confirm, Result) after the UI changes; check light mode, large font, TalkBack labels.
2. First real end-to-end test on stage: answer one transaction, confirm the draft in ERPNext, Undo works, second phone sends fresh SMS (live receiver path).
3. Final docs/copy sync: (the disclosure and `docs/play-sms-declaration.md` now cover the user-chosen backfill window) mention Sentry is off by default and quarantine pruning; remove internal task names from `docs/release.md` and `docs/pilot-checklist.md`.
4. Measure memory on a release build (a debug build uses about 640 MB; expect 120 to 250 MB in release). If high, virtualise the Inbox list.
5. Device checks still open: keyboard overlap, dark/light, TalkBack, site switch, "Grant SMS permission", credit transfer between own accounts, receiver idle test on the production receiver, OTP drop on hardware, "bill paid by card" with a real submitted Purchase Invoice.
6. Final whole-branch review (most capable model), then finishing the development branch.

## Things only the user can do
Review the design mockup (optional); decide GitHub privacy and approve a push after history cleanup; rotate the credentials that were pasted in chat during setup (stage and prod keys, a password); ask the ERPNext admin to delete two cancelled test invoices on stage (PINV-26-00029, PINV-26-00030); submit the Play SMS declaration; `eas init` and Play Console setup.

## Stage data facts (for testing)
Three Bank Accounts exist on stage: an ICICI savings account, "IDFC First - Zen Pivot - IDFC First" (current account, number ends 6507) and "IDFC Credit Card - IDFC First" (the card, endings 3455 and 8129 in SMS). Setup only lists accounts flagged **Is Company Account**; the card account had to be flagged. The setup wizard asks the user to type the last four digits per account: the SMS account ending must match the mapping or messages for it are treated as an unrecognised account and skipped (re-read on the next app open while inside the chosen window).

## Key decisions (digest of the rulings)
**Stack and architecture.** React Native with Expo (dev build, not Expo Go) was chosen over native Kotlin and Flutter for speed with a Kotlin module for the SMS receiver; iOS is future. `frappe-js-sdk` is not used (thin typed `fetch` client instead). No custom Frappe app: only REST/whitelisted calls. Shared JSON templates for TS and Kotlin parsers.
**Parsing.** Missing SMS dates derive from `receivedAt` (IST). `rawHash` = hash of sender and normalised body, no timestamp. OTP, money-verb and amount patterns live in the template file; load-time validation rejects patterns that match the empty string. Card "thank you for payment" messages, declines, refunds, FD and EMI messages are out of scope for phase 1. IMPS alerts are current-account movements. Standing-instruction card payments pair with the later card spend. A second SMS about the same payment merges into one item (`mergedCount`).
**Receiver.** Stores a message only if the sender is configured AND it parses, or it looks like money but is unrecognised (never OTPs). Native bridge exposes `peek` and `ack` so a crash cannot lose messages. The widened OTP detector treats `OTP <4 to 8 digits>` as OTP even inside a transaction text (known trade-off, KL3). Lock-screen notifications show no amount, sender or account.
**ERPNext writes.** Every plan is a list of steps run by the outbox runner: write-ahead `attempting` marker, create, record; idempotent by reference (`reference_no`/`cheque_no` = real UTR else `AL-<hash>`); compensation deletes only drafts the app created; Undo is allowed only for drafts and never deletes an adopted or shared document. Replacing an answer supersedes the old outbox item in one DB transaction. A foreign-currency charge needs the rupee amount from the user (otherwise it stays in the Inbox).
**Duplicate safety (20A).** Adoption of an existing document by the same UTR: another transaction's document is adopted only when it is the other half of the same internal transfer (same accounts, amount, company, no party; Journal Entries compared row by row). A hit nobody claims is adopted only if it matches the planned type, direction, amount and party; otherwise the app BLOCKS with "An entry X already exists for this reference. Open it in ERPNext and check it, or ask your accountant" rather than create a second document. Documents recorded in other transactions' unfinished outbox items count as claimed.
**Internal transfers (own accounts).** The credit leg links to its debit leg using the stored plan (same two ledger accounts and amount, opposite direction, INR, within 3 days, exactly one candidate); with several candidates it books its own document.
**Sync and trust.** `last_synced_at` is written only when the cycle had no failed step AND ERPNext actually answered. Home trust labels follow `src/core/trust.ts`; drafts are shown as separate in/out totals (INR only) and are not in the figures above them. The app is bound to one site (`site_url`); signing in to a different site wipes local data first.
**Auth.** Password login generates an API key (System Manager only); otherwise the user pastes an API key and secret. The password is never stored; the session sits in SecureStore. Sign-out also ends the Frappe cookie session (best effort).
**Privacy and crash reporting.** Sentry is JavaScript-only, off unless `EXPO_PUBLIC_SENTRY_DSN` is set, with a pure `scrubEvent` that removes amounts, references, emails, hosts and SMS fields and drops the event if scrubbing fails. Android: `allowBackup` false, minSdk 26. Release builds reject `http://`.
**Pilot release.** First pilot ships v1 without over-the-air updates; templates are bundled (an override is accepted only if its version is not older than the bundled one).

## Known limitations (accepted for the pilot)
- KL1/KL2 are mostly addressed; a stale or lost `adopted` flag can still leave a stray draft after a crash.
- KL3: contrived transaction texts like "Never share OTP 1234" can be dropped as OTPs (silent).
- KL4: an accountant's hand-made draft with the same reference but different details blocks the second transaction until the accountant checks it; there is no in-app way around it.
- First-time customer credit takes about 5 taps (3 with a saved rule); detached documents can be re-adopted on re-answer.
- Journal Entry reversal edge cases and "several equal candidates" internal transfers book extra drafts (warned before creation).
- Settings Edit opens the whole account step; Home trust line appears only with exactly one bank account; credit card outstanding is not on Home; no custom typeface; UPI icon is a heuristic; backfill window is user-chosen (see rulings).
- The 24 lakh bank balance on Home is the ERPNext ledger balance of the stage test books, not an SMS figure.
- Two unanswered advances can both use the same order's "left to pay", because only submitted advances count, so the accountant may see a rejected submit.
- Messages older than AutoLedger may already be booked by hand in ERPNext. Only items with a UTR are matched by reference, so card spends can become duplicate drafts. A window that crosses 1 April lands in the previous financial year.
- The SMS read stops at 5000 messages per scan.
- The "may already be in ERPNext" check reads at most 1,500 entries per document type, newest first. When it stops early, older items show "We could not check older entries in ERPNext for this one." and get no warning. It is a warning only: it never blocks an answer.
- "Found N" after a scan counts second messages and already-known items too.
- Activity totals count both legs of an own-account transfer in money in and money out; net is unaffected.

## How we work
Subagent-driven: a controller dispatches one implementer per task or group (explicit model each), gets a per-group review, runs fix rounds (max 5), and merges. Parallel groups use worktrees with disjoint files. The controller does not edit product code except merge integration or tiny verified fixes. Every decision goes into the ledger as `Ruling: what, why, cost if wrong`.

## Ruling: SMS backfill window (wave 2)

The window is user-chosen (1 week, 1 month, 3 months, 6 months, All time), default 1 week, stored as setting `backfill_days` and changeable in Settings (changing it re-runs the backfill once). Senders are still limited to the configured banks. A larger window never duplicates or reopens answered items (same `rawHash` dedupe).

The full chosen window is read only when it is set (setup) or grown (Settings). Routine foreground cycles read the larger of 7 days and the days since the last read plus one day of overlap, never more than the chosen window. The native SMS read stops at 5000 messages per scan (`BACKFILL_CAP` in `SmsIngestModule.kt`, raised from 1000), newest first. "All time" is stored as `backfill_days` = `0` and passed to native as 0 (no lower date bound, `BackfillQuery.kt`); only setup and the Settings change read it, routine cycles read the short window. Native `backfill` returns `{ messages, truncated }`; when more than 5000 matched, setup and Settings say "Showing the newest 5,000 messages. Older ones were not read."
