# Spike report

## B. ERPNext API behaviour on stage (Frappe 16.54 / ERPNext 16.53 / India Compliance 16.11)

Run: `npx tsx scripts/spike/erp-spike.ts` (`--create-pi --i-accept-undeletable-residue` builds a test Purchase Invoice and leaves undeletable residue; see B.12). Target: `https://stageatom.onebook.app` only; the script refuses any other URL. Date of run: 2026-11-08. Company: Zen Pivot Venture Studio Private Limited (INR).

Result: **9 checks PASS, with one failing sub-result inside check 8**: `erpnext.accounts.utils.get_balance_on` FAIL (not whitelisted in v16), replaced by the GL Entry SUM (PASS, matched the Trial Balance exactly); AR/AP Summary report PASS. The script prints this per-check sub-result in its summary. Four checks only passed after the first run exposed real v16 differences (see the "differs from spec" list). Everything below is observed unless marked **(source)** or **(not verified)**.

### B.0 Differences from spec section 11 (read this first)

1. **`generate_keys` requires the caller to be a System Manager.** A user without that role gets `403 {"exc_type":"PermissionError"}` with no message and no role name. The spec's "sign in with your own password, we mint your key" works only for System Managers. Tasks 10 and the login screen must offer a second path: paste an API key/secret created in ERPNext (User > API Access). See B.2.
2. **`erpnext.accounts.utils.get_balance_on` is not whitelisted in v16.** `403 ... Function erpnext.accounts.utils.get_balance_on is not whitelisted.` Use a `GL Entry` aggregate through `frappe.client.get_list` (B.8). Do not use `bank_reconciliation_tool.get_account_balance`: it returns the bank-statement side (about 0 here, with float noise `5.8e-11`), not the book balance.
3. **`mode_of_payment` is mandatory on every Payment Entry** (all three payment types). Omitting it gives `417 MandatoryError`. The app must read the site's Mode of Payment list and pick one (see B.3).
4. **Document creation returns `200 {"data": {...full doc...}}`, and `DELETE /api/resource/<doctype>/<name>` returns `202 {"data":"ok"}`**, not 201/204. Treat any 2xx as success.
5. **`SUM(...)` strings are rejected** in `fields` (`ValidationError: SQL functions are not allowed as strings in SELECT`). Use the dict form `{"SUM":"debit","as":"debit"}`.
6. **A closed Accounting Period blocks draft creation at insert time** (not only at submit). Good for the app: the error comes back on `createDraft`. But a date before any Fiscal Year is **accepted** as a draft (no fiscal-year check until submit, not tested).
7. **Permission errors name the doctype and user, not a role.** `ErpAuthError.missingRole` cannot be filled from the payload; carry the doctype instead (B.9).
8. **Customer create with no `customer_name` returns HTTP 500** (`AttributeError`), not a MandatoryError. The client must validate `customer_name` / `supplier_name` itself.
9. A submitted-then-cancelled Purchase Invoice **cannot be deleted** through the API (`LinkExistsError ... Payment Ledger Entry`), even for System Manager. This does not affect the app (it only deletes drafts) but it means spike runs that build a test invoice leave residue.

### B.1 Token auth: PASS

`GET /api/method/frappe.auth.get_logged_user` with `Authorization: token KEY:SECRET`:

```
200 {"message":"tools.zenpivot@gmail.com"}
```

Invalid pair or right key with wrong secret: `401 {"exc_type":"AuthenticationError"}`. No header on a resource call: `403 {"exc_type":"PermissionError","_server_messages":[{"message":"Insufficient Permission for <strong>Payment Entry</strong>"...}]}`. Note that a missing header does not return 401: treat 401 as "bad key", 403 as "not allowed or no auth".

`GET /api/method/frappe.utils.change_log.get_versions` (token auth, works) gives `{"message":{"frappe":{"version":"16.54.0"},"erpnext":{"version":"16.53.0"},"india_compliance":{"version":"16.11.0"},...}}`. Usable for the app's "supported version" check.

### B.2 Login + `generate_keys` on throwaway users: PASS (with a major caveat)

Executed with two throwaway System Users created over the API (random password, `send_welcome_email: 0`), both deleted afterwards. The real user's key was never rotated.

- Login: `POST /api/method/login`, form-encoded or JSON `{usr, pwd}`, no Authorization header.
  - Success: `200 {"message":"Logged In","home_page":"helpdesk","full_name":"..."}` plus cookies `sid, system_user, full_name, user_id, user_lang`.
  - Wrong password / unknown user: `401 {"message":"Invalid login credentials","exc_type":"AuthenticationError"}`.
  - 2FA response shape: **not verified** (no 2FA user available). Per Frappe source the body carries a `verification` object and `tmp_id` instead of "Logged In"; Task 10 should treat anything other than `message == "Logged In"` as "needs 2FA / unknown" and show a "complete login in ERPNext" path.
- Existing api_key visibility: a user can read its own User doc with the session cookie (`GET /api/resource/User/<email>` returns 200). Before `generate_keys`: `api_key: null`, no `api_secret` field. After: `api_key` populated, `api_secret` returned masked (`"********"`), never the real value. So **an existing key is detectable** before rotating: read own User doc, check `api_key` non-null. That is how Task 10's `confirmRotate` decision works. The pilot user (read with its token) can also read its own doc.
- Mint: `POST /api/method/frappe.core.doctype.user.user.generate_keys`, body `user=<email>` (form or JSON).
  - Success: `200 {"message":{"api_key":"...","api_secret":"..."}}`.
  - **CSRF is not needed** with the session cookie (call succeeded with no `X-Frappe-CSRF-Token`). Cookie jar handling in React Native is therefore not a blocker; send the cookie header manually or let the platform store it.
- Rotation (confirms the spec's warning): a second call keeps the **same `api_key` and issues a new `api_secret`**; the old pair then returns 401, the new pair 200.
- **Non-System-Manager: `generate_keys` for self returns `403 {"exc_type":"PermissionError","exception":"frappe.exceptions.PermissionError"}`** (no message, no role). Same payload via token auth and via session. Frappe source: **(source)** `@frappe.whitelist(methods=["POST"])` with `frappe.only_for("System Manager")`.
- The pilot user "Auto Ledger" (`tools.zenpivot@gmail.com`) now holds roughly 75 roles including System Manager (the stage owner added permissions mid-spike; before that, User create, Supplier create, Customer delete and `generate_keys` were all 403 for it). An accountant's real login user will usually NOT be a System Manager.

**Recommendation for Task 10 / login screen:** primary path = the user pastes an API key and secret (generated in ERPNext) alongside the site URL; verify with `frappe.auth.get_logged_user`. Secondary path = username/password login + `generate_keys` when it works; on `403 PermissionError` from `generate_keys`, show "Your ERPNext user is not allowed to create API keys. Ask an administrator for a key, or sign in as a System Manager." Keep the rotate-confirmation exactly as in spec section 11 (api_key non-null => warn).

### B.3 Draft Payment Entry (Receive, Customer, unallocated), find by `reference_no`, delete: PASS

`POST /api/resource/Payment Entry` (works with doctype URL-encoded). Body that works:

```json
{ "company": "<company>", "posting_date": "2026-11-08", "payment_type": "Receive",
  "party_type": "Customer", "party": "<customer>", "mode_of_payment": "Wire Transfer",
  "paid_to": "IDFC First - ZP", "paid_amount": 1234.56, "received_amount": 1234.56,
  "reference_no": "<UTR>", "reference_date": "2026-11-08" }
```

Response `200 {"data":{ "name":"ACC-PAY-2026-00039","docstatus":0,"paid_from":"Debtors - ZP","unallocated_amount":1234.56,"reference_no":"<UTR>","reference_date":"2026-11-08", ...}}`.

- `paid_from` is filled by the server from the party (Debtors - ZP). Send it explicitly anyway.
- Without `mode_of_payment`: `417 {"exception":"frappe.exceptions.MandatoryError: [Payment Entry, ACC-PAY-2026-00039]: mode_of_payment","exc_type":"MandatoryError","_server_messages":[{"message":"Error: Value missing for Payment Entry: Mode of Payment","title":"Message"}]}`.
- Mode of Payment names on stage (type Bank): `Bank Draft, Cheque, Credit Card Bank Entry, Current Account Bank Entry, ICICI, Wire Transfer` (plus `Cash`). Recommend the app lists `Mode of Payment` (enabled=1) in the setup wizard and stores one default per mapped account (suggest `Current Account Bank Entry` for a current account, `Credit Card Bank Entry` for a card). (ad-hoc observation, not reproduced by erp-spike.ts)
- Bank-type modes make `reference_no` + `reference_date` mandatory (`getdoctype` shows `mandatory_depends_on` on both). Omitted: `417 ValidationError "Reference No and Reference Date is mandatory for Bank transaction"`. The app always has the UTR (or the derived hash, per plan Task 12), so this is satisfied. (ad-hoc observation, not reproduced by erp-spike.ts)
- Find by UTR: `GET /api/resource/Payment Entry?filters=[["reference_no","=","<UTR>"]]&fields=["name","docstatus","reference_no"]` => `200 {"data":[{"name":"ACC-PAY-2026-00039","docstatus":0,"reference_no":"<UTR>"}]}`. Exact match works (filters are JSON-encoded query params).
- Delete draft: `DELETE /api/resource/Payment Entry/<name>` => `202 {"data":"ok"}`.
- Receive against an open Sales Invoice with a partial amount also works as a draft: add `"references":[{"reference_doctype":"Sales Invoice","reference_name":"ZP-SI-26-00012","allocated_amount":1000}]` (`unallocated_amount` becomes 0). The invoice's `outstanding_amount` does not change while the PE is a draft.

### B.4 Draft Journal Entry with `cheque_no` = UTR: PASS

`POST /api/resource/Journal Entry`:

```json
{ "company": "<company>", "posting_date": "2026-11-08", "voucher_type": "Journal Entry",
  "cheque_no": "<UTR>", "cheque_date": "2026-11-08", "user_remark": "...",
  "accounts": [
    { "account": "Miscellaneous Expenses - ZP", "debit_in_account_currency": 500 },
    { "account": "IDFC Credit Card - ZP", "credit_in_account_currency": 500 } ] }
```

- `200`, `docstatus 0`, name `ACC-JV-2026-00135`, `total_debit == total_credit == 500`.
- `cost_center` is **auto-filled with `Main - ZP` on both rows** when omitted (not required from the client).
- `cheque_no` requires `cheque_date` (sending `cheque_no` alone: `417 MandatoryError "Please enter Reference date"`). Always send both.
- `voucher_type` `"Credit Card Entry"` is also accepted for this shape. Recommend `"Journal Entry"` for card spends (plain, no side effects), unless the accountant prefers the card voucher type; either is a draft.
- Find: `GET /api/resource/Journal Entry?filters=[["cheque_no","=","<UTR>"]]&fields=["name","docstatus","cheque_no"]` => one row. Delete: 202.
- Expense row sign convention is standard: debit expense, credit the card GL.

### B.5 Payment Entry (Pay, Supplier) with `paid_from` = card liability account: PASS (accepted)

**Recommendation: use the Payment Entry; no Journal Entry fallback is needed.** `IDFC Credit Card - ZP` is `account_type: Bank`, `root_type: Asset` on this site, so ERPNext treats it as a bank-like account. Body accepted as a draft, both unallocated and against a freshly submitted Purchase Invoice (`PINV-26-00030`, outstanding 1000): (ad-hoc observation, not reproduced by erp-spike.ts)

```json
{ "company": "<company>", "posting_date": "2026-11-08", "payment_type": "Pay",
  "party_type": "Supplier", "party": "Bharti Airtel Limited",
  "mode_of_payment": "Credit Card Bank Entry",
  "paid_from": "IDFC Credit Card - ZP", "paid_to": "Creditors - ZP",
  "paid_amount": 1000, "received_amount": 1000,
  "reference_no": "<UTR>", "reference_date": "2026-11-08",
  "references": [{ "reference_doctype": "Purchase Invoice", "reference_name": "PINV-26-00030", "allocated_amount": 1000 }] }
```

Response `200`, `docstatus 0`, `unallocated_amount 0`, found by `reference_no`, deleted `202`. Pass `paid_to` = the party's payable account (`Creditors - ZP` here; read it from `Company.default_payable_account` or `get_payment_entry`).

Validation errors seen when the reference is wrong: `417 ValidationError "Purchase Invoice PINV-26-00001 is not associated with Supplier Bharti Airtel Limited"` (party must match the invoice).

**Not verified:** that the accountant's later **submit** of such a PE succeeds (I did not submit or cancel any Payment Entry, to avoid un-deletable ledger residue). The card account is type Bank so I expect it to, but flag it in the user docs. If an accountant reports a submit failure, the Journal Entry fallback (party row with `reference_type: "Purchase Invoice"`, `reference_name`) is the documented alternative; it was accepted as a draft in an earlier run of this spike using a PI of the same shape (debit `Creditors - ZP` with `party_type: Supplier`, `party`, credit card GL). (ad-hoc observation, not reproduced by erp-spike.ts)

Helper for building a PE from an invoice (not required): `GET /api/method/erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry?dt=Purchase Invoice&dn=<name>` returns a full unsaved PE (with `paid_from` defaulted to the company bank account; override with the card GL).

### B.6 Internal Transfer Payment Entry: PASS

```json
{ "company": "<company>", "posting_date": "2026-11-08", "payment_type": "Internal Transfer",
  "mode_of_payment": "Wire Transfer", "paid_from": "IDFC First - ZP", "paid_to": "IDFC Credit Card - ZP",
  "paid_amount": 777, "received_amount": 777, "reference_no": "<UTR>", "reference_date": "2026-11-08" }
```

`200`, `docstatus 0`, no party fields, `unallocated_amount 0`. `mode_of_payment` is mandatory (same MandatoryError without it). Findable by `reference_no`; deletable (202). Both accounts are the GL accounts (not the Bank Account doc names).

### B.7 `frappe.desk.form.load.getdoctype`: PASS

`GET /api/method/frappe.desk.form.load.getdoctype?doctype=Customer&with_parent=1` => `200 {"docs":[ {name:"Customer", fields:[...]}, ...child tables... ], "user_settings": ...}`. The main doc is the entry whose `name == doctype`. Each field has `fieldname, label, fieldtype, reqd, default, options, mandatory_depends_on`.

Required (`reqd == 1`) fields found on this site:

| Doctype | reqd fields |
|---|---|
| Customer | `customer_name`, `customer_type` (default "Company"), `gst_category` (default "Unregistered") |
| Supplier | `supplier_name`, `supplier_type`, `gst_category` |
| Employee | `naming_series, first_name, gender, date_of_birth, date_of_joining, status, company` |
| Payment Entry | `naming_series, payment_type, posting_date, company, mode_of_payment, paid_from, paid_from_account_currency, paid_to, paid_to_account_currency, paid_amount, source_exchange_rate, base_paid_amount, received_amount, target_exchange_rate, base_received_amount` (most are server-defaulted) |
| Journal Entry | `company, voucher_type, naming_series, posting_date, accounts` |

Conditional: `mandatory_depends_on` is set on Payment Entry (`reference_no`, `reference_date`, `tax_withholding_category`), Journal Entry (`cheque_no`, `cheque_date`, ...), Employee (`relieving_date`). The expression is a JS string; Task 11's `getRequiredFields` should return only `reqd == 1` fields that have no `default` (those are what the user must supply), and treat `mandatory_depends_on` as "ignore unless known".

India Compliance fields on Customer: `gstin` (Autocomplete, optional), `pan` (Data, optional), `gst_category` (Select, **required but defaulted to "Unregistered"**, so a bare Customer create works). Custom fields appear in the same `fields` list; there is no separate flag except the module/custom markers.

### B.8 Reports and balances: PASS

**AR / AP totals:** `POST /api/method/frappe.desk.query_report.run`

```json
{ "report_name": "Accounts Receivable Summary",
  "filters": { "company": "<company>", "report_date": "2026-11-08", "ageing_based_on": "Due Date", "range": "30, 60, 90, 120" },
  "ignore_prepared_report": true }
```

(same for `"Accounts Payable Summary"`). Response `200 {"message":{"result":[...],"columns":[...],"report_summary":null,"add_total_row":...}}`.
- `result` = one **object** per party (keys: `party, party_type, advance, invoiced, paid, credit_note, outstanding, total_due, range0..5, currency, ...`) **followed by one array total row**, positional by `columns`: `["Total","",advance,invoiced,paid,credit_note,outstanding,...]`. `report_summary` is null (no numbers there).
- **Recommendation:** `receivableMinor` = sum of the object rows' `outstanding` (or the total array row at the index of the `outstanding` column from `columns`). The two agreed exactly on stage (AR 1,121,725; AP 250,526). The column order differs between AR (has `territory, customer_group`) and AP (`supplier_group`), so look the index up from `columns[].fieldname`, never hardcode.
- This confirms spec section 11: AR `outstanding` is net of unallocated advances. Naive `SUM(outstanding_amount)` on submitted Sales Invoices = 1,631,725 vs report 1,121,725 (the 510,000 difference equals the report's `advance` total). For payables the naive Purchase Invoice sum is 0 while the report shows 250,526 (balances come from other vouchers). The report is the right source, as the spec says.

**Bank / card balance** (replacement for `get_balance_on`):

```
GET /api/method/frappe.client.get_list
  ?doctype=GL Entry
  &fields=[{"SUM":"debit","as":"debit"},{"SUM":"credit","as":"credit"}]
  &filters=[["account","=","IDFC First - ZP"],["company","=","<company>"],["is_cancelled","=",0],["posting_date","<=","2026-11-08"]]
=> 200 {"message":[{"debit":2682914.0,"credit":197996.42}]}
```

Balance = `debit - credit` = 2,484,917.58 for `IDFC First - ZP`; it equals the Trial Balance report's closing net for the same account exactly. Other accounts: `IDFC Credit Card - ZP` 4,488.74 (debit minus credit; a card that owes money would be negative), `ICICI - ZP` 500,000. Round with `Math.round(x * 100)` to minor units. Requires read permission on GL Entry (the pilot user has it; a restricted user may not, so show "balance unavailable" rather than error).

### B.9 Error payloads: PASS

All Frappe errors carry `exc_type` (stable), `_server_messages` (a JSON **string** that must be parsed twice: array of JSON strings, each `{message, title, indicator}`), and often `exception` ("<python.path.Class>: text") and a python traceback in `exc` (never show it). Messages contain HTML (`<strong>`); strip tags for display.

| Case | HTTP | `exc_type` | Message / notes |
|---|---|---|---|
| Missing required field (Payment Entry) | 417 | `MandatoryError` | `exception: "frappe.exceptions.MandatoryError: [Payment Entry, ACC-PAY-2026-00039]: mode_of_payment"`; `_server_messages[0].message = "Error: Value missing for Payment Entry: Mode of Payment"` |
| Missing required fields (Employee) | 417 | `MandatoryError` | `exception: "...MandatoryError: [Employee, HR-EMP-00015]: gender, date_of_birth, date_of_joining"` and **one `_server_messages` entry per field**: `"Error: Value missing for Employee: Gender"` etc. Parse field *labels* from the messages (`Value missing for <Doctype>: <Label>`) or fieldnames from the `exception` suffix after the last `]: `, comma-separated |
| Other validation | 417 | `ValidationError` | `exception: "frappe.exceptions.ValidationError: Party Type is mandatory"`; message `"Party Type is mandatory"` (no `Value missing`, so not machine-parsable as a field) |
| Closed Accounting Period (draft insert) | 417 | `ClosedAccountingPeriod` | `exception: "erpnext.accounts.doctype.accounting_period.accounting_period.ClosedAccountingPeriod: You cannot create a Payment Entry within the closed Accounting Period <strong>X - ZP</strong>"`. Identify by `exc_type == "ClosedAccountingPeriod"`. Same for Journal Entry. |
| Customer missing `customer_name` | **500** | `AttributeError` | `exception: "AttributeError: 'NoneType' object has no attribute 'strip'"`; no `_server_messages`. Validate client-side. |
| Wrong party for invoice | 417 | `ValidationError` | `"Purchase Invoice PINV-26-00001 is not associated with Supplier Bharti Airtel Limited"` |
| Bad key/secret | 401 | `AuthenticationError` | body is just `{"exc_type":"AuthenticationError"}` |
| Login failure | 401 | `AuthenticationError` | `{"message":"Invalid login credentials","exc_type":"AuthenticationError"}` |
| No permission on doctype (POST) | 403 | `PermissionError` | `{"exc_type":"PermissionError","_server_messages":[{"message":"User <strong>x@example.com</strong> does not have doctype access via role permission for document <strong>Supplier</strong>"}],"_error_message":"No permission for Supplier"}` |
| No permission (GET list) | 403 | `PermissionError` | `"Insufficient Permission for <strong>Payment Entry</strong>"` |
| No report access | 403 | `PermissionError` | `"You don't have access to Report: Accounts Receivable Summary"` |
| Non-whitelisted method | 403 | `PermissionError` | `"Function <strong>erpnext.accounts.utils.get_balance_on</strong> is not whitelisted."` |
| `generate_keys` as non-System-Manager | 403 | `PermissionError` | no message at all |
| Not found | 404 | `DoesNotExistError` | e.g. `"User x not found"` | (ad-hoc observation, not reproduced by erp-spike.ts)

**No 403 message names a role.** The plan's `ErpAuthError.missingRole` must be changed to `deniedDoctype?: string` (parse the text between `document <strong>` and `</strong>`, or `No permission for X` from `_error_message`), and the plain-language message becomes "Your ERPNext user is not allowed to do this on <doctype>. Ask your ERPNext administrator for access." Task 10's test "a 403 body naming a role yields missingRole" cannot be written against real payloads as stated.

Closed-period date handling for Review Focus 4: Accounting Period closure surfaces at **draft create** as `ClosedAccountingPeriod`; the app should map it to `closedPeriod: true` by `exc_type`, not by regex on text. **Not verified:** the "Accounts Frozen Upto" setting (Accounts Settings) and a closed Fiscal Year / Period Closing Voucher; per ERPNext source these fire at submit, so drafts will succeed and the accountant sees the error later.

A date before any Fiscal Year (2020-01-15) was **accepted** as a draft Journal Entry, so the app should not rely on the server rejecting out-of-range dates; use the posting date from the SMS as is, and let the accountant fix it.

### B.10 Reference fields for UTR dedupe (open question answered)

- Payment Entry: `reference_no` (+ `reference_date`). Filter works: `[["reference_no","=",utr]]`.
- Journal Entry: `cheque_no` (+ `cheque_date`). Filter works: `[["cheque_no","=",utr]]`.
- Both are plain Data fields, indexed or not, query time is fine on stage (hundreds of rows). Existing real Payment Entries on the site store free-text bank narrations in `reference_no` (e.g. `NEFT/AXODH24720831250/CONTISHIP LOGISTICS PRIVATE`, `HDFCH01307872608`), so **exact match on the UTR will miss entries the accountant typed in a different format**. Task 11's `findDraftByUtr` should use exact match for idempotency of the app's own documents; a looser `like %UTR%` lookup is optional later, not required for phase 1. (ad-hoc observation, not reproduced by erp-spike.ts)
- Dedupe must cover submitted docs too (the accountant may have submitted before retry): `findDraftByUtr` already returns `docstatus`; keep the name but do not filter on docstatus in the query.

### B.11 `frappe-js-sdk` vs thin client: choose the thin typed client over `fetch`

Checked in a scratch directory (not added to the app): `frappe-js-sdk@1.14.1` (depends only on `axios ^1.18.1`, 148 KB itself, plain CJS `lib/index.js`).

- It imports and authenticates in Node/TS: `new FrappeApp(url, { useToken: true, token: () => "KEY:SECRET", type: "token" })`, then `app.call().get("frappe.auth.get_logged_user")` => `{"message":"tools.zenpivot@gmail.com"}`; `app.db().getDocList("Mode of Payment", {fields:["name"], limit:2})` worked.
- Error handling is the problem for this app: on failure it rejects with an object `{httpStatus, httpStatusText, message: "There was an error while creating the document.", exc_type, _server_messages, exception, exc}`, replacing the server's text with a generic `message`. All the error classification in Task 10 (`MandatoryError` fields, `ClosedAccountingPeriod`, permission doctype) needs the raw `exception`/`_server_messages`, which are still present but unstructured and typed `any`.
- It has no typing for `getdoctype`, report runs or `frappe.client.get_list` aggregates, and sets `withCredentials` by default. It adds axios (about 2.3 MB on disk, XHR adapter) to a React Native bundle; axios 1.x runs on RN, but I could not verify behaviour on-device in this environment (**not verified on a device**), and RN's native cookie jar can attach a stale `sid` cookie to token-authenticated requests.
- Every call the app needs is a plain GET/POST/DELETE with a header. A ~100-line `ErpClient` over `fetch` (as Task 10 already specifies, with injectable `fetchImpl` for mocked tests) is simpler to test and gives exact control of error parsing.

**Decision: thin typed client over `fetch`; do not add `frappe-js-sdk`.** Neither dependency was added to `package.json`.

### B.12 Residue and cleanup

Every document created by the script is deleted in a `finally` block and a sweep by the run tag (`ZZSPIKE<hex>`) is printed. Final status of the last run: nothing remaining.

Left on stage from earlier iterations of this spike (cannot be deleted via the API, net-zero ledger effect, `docstatus = 2` cancelled):
- Purchase Invoice `PINV-26-00029` (supplier "Bharti Airtel Limited", bill_no `ZZSPIKE663AE6-BILL`, 1000)
- Purchase Invoice `PINV-26-00030` (same supplier, bill_no `ZZSPIKE124140-BILL`, 1000)

Both are cancelled with reversing GL and Payment Ledger Entries (`delinked = 1`). Deleting them needs delete permission on "Payment Ledger Entry" (the pilot key got `403` on it). An administrator can delete them from the desk. `--create-pi` is now guarded: it prints a warning and exits before touching stage unless `--i-accept-undeletable-residue` (or `ACCEPT_STAGE_RESIDUE=1`) is also given. Only use it if an open Purchase Invoice is genuinely needed and an admin will clean up afterwards.

Throwaway Users, the temporary Accounting Period, drafts and the one throwaway Customer were all removed (the Customer needed the extra delete permission the owner granted mid-spike; before that it was only disabled). Document number series (ACC-PAY, ACC-JV, HR-EMP, etc.) skipped a few numbers; harmless.

### B.13 Facts later tasks need (quick reference)

| Need | Use |
|---|---|
| Auth header | `Authorization: token KEY:SECRET` |
| Who am I | `GET /api/method/frappe.auth.get_logged_user` => `{message: email}` |
| Mint key | `POST /api/method/frappe.core.doctype.user.user.generate_keys` `{user}` (System Manager only) |
| Detect existing key | session `GET /api/resource/User/<email>` => `api_key` null or string |
| List docs | `GET /api/resource/<Doctype>?fields=[...]&filters=[[f,op,v]]&limit_page_length=N` (JSON-encoded params) |
| Create | `POST /api/resource/<Doctype>` => 200 `{data: doc}` |
| Delete | `DELETE /api/resource/<Doctype>/<name>` => 202 `{data:"ok"}` |
| Status check | `GET /api/resource/Payment Entry?fields=["name","docstatus"]&filters=[["name","in",[...]]]` (standard list call; the `in` filter itself was not exercised in the spike) |
| Required fields | `GET /api/method/frappe.desk.form.load.getdoctype?doctype=X` => `docs[name==X].fields[]` |
| Receivable / payable | `POST /api/method/frappe.desk.query_report.run` (B.8) |
| Account balance | `GET /api/method/frappe.client.get_list` over GL Entry with `{"SUM":...}` fields (B.8) |
| Payment Entry mandatory extras | `mode_of_payment`, `reference_no`, `reference_date` |
| Journal Entry extras | `cheque_no` + `cheque_date` together |
