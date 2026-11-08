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
- Ids starting with `synthetic-` are hand-written (OTP, non-IDFC senders).

## Redaction

Bodies are redacted by `scripts/redact-sms.ts` (`npx tsx scripts/redact-sms.ts <raw.json> <out.json>`; the raw export is never committed). Amounts, dates, times, balances, wording and well-known merchant names are untouched. Replaced: person and company names (`PERSON_n` / `COMPANY_n`, stable within a run), digit runs of 6+ outside amounts (same value maps to the same fake, capped at 8 digits so no 9+ digit run exists), the digits of masked accounts except the last 4, shortlink and SiHub/Mandate tokens (same length, random). The toll-free number `180010888` is written as `1800 10 888`. The block-card short code `5676732` is public and kept.

`receivedAt` is real. Do not add unredacted messages to this folder.
