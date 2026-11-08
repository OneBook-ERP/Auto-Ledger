# SMS fixtures

`idfc.json` holds redacted real IDFC First Bank SMS plus a few synthetic ones. It is the spec for the SMS parser (Task 5) and the matcher (Task 6).

Each entry:

```ts
{ id: string; sender: string; body: string; receivedAt: number /* epoch ms */;
  expected: { ok: true; txn: Partial<ParsedTxn> } | { ok: false; reason: 'otp'|'si_notice'|'not_money'|'unknown_template' } }
```

- `expected.txn` lists the fields the SMS determines. `sender`, `receivedAt` and `rawHash` are not repeated: they come from the fixture or are computed. Fields that the SMS does not state are `null`; fields the SMS does not determine unambiguously are omitted (for example `accountLast4` on IMPS messages, which only show a 3-digit mask).
- When the body has no date (NEFT confirmations), `occurredOn` is the Asia/Kolkata date of `receivedAt` and `occurredTime` is `null`.
- Amounts are integer minor units. `utr` for IMPS messages is the IMPS reference number.
- Ids starting with `synthetic-` are hand-written (OTP, non-IDFC senders, and the widened-heuristic cases below). Their account digits, references and `PERSON_n` names are invented.
- Widened money heuristic (template version 2, Task 20B), all from IDFC senders, none matching a template:
  - kept as `unknown_template` (money-like, so stored as "unrecognised" natively and shown in-app, never notified): `synthetic-idfc-rupee-debit` (amount with the rupee sign), `synthetic-idfc-upi-sent` ("sent ... via UPI"), `synthetic-idfc-rupee-received` (rupee-sign credit), `synthetic-idfc-inr-suffix-transferred` (amount followed by `INR`);
  - marketing that must never notify: `synthetic-idfc-marketing-cashback` and `synthetic-idfc-marketing-loan` stay `not_money` (no money verb); `synthetic-idfc-marketing-loan-credited` and `synthetic-idfc-marketing-voucher-received` are `unknown_template`: accepted false keeps (a money verb plus an amount), stored unparsed but never notified.
- `synthetic-otp-is-code` and `synthetic-otp-one-time-password` cover the "OTP for ... is <code>" and "One Time Password ... is <code>" forms.
- Other `synthetic-otp-*` fixtures (added with the Task 20B OTP fix) cover OTPs that mention a payment/transfer (they contain money verbs and amounts, so the OTP check must win) and the separator variants (`OTP is: 123456`, `OTP - 123456`, `One Time Password 884210`, `Your OTP to login is ...`, an amount with `Rs.` inside the window). The otpPattern change keeps template version 2 (unreleased).
- Do not change an existing fixture's `expected` to fit a template change; if a change flips one, narrow the change.

## Redaction

Bodies are redacted by `scripts/redact-sms.ts` (`npx tsx scripts/redact-sms.ts <raw.json> <out.json>`; the raw export is never committed). Amounts, dates, times, balances, wording and well-known merchant names are untouched. Replaced: person and company names (`PERSON_n` / `COMPANY_n`, stable within a run), digit runs of 6+ outside amounts (same value maps to the same fake, capped at 8 digits so no 9+ digit run exists), the digits of masked accounts except the last 4, shortlink and SiHub/Mandate tokens (same length, random). The toll-free number `180010888` is written as `1800 10 888`. The block-card short code `5676732` is public and kept.

`receivedAt` is real. Do not add unredacted messages to this folder.
