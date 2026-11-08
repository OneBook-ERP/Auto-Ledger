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

## A. SMS receiver on the OEM phone

Result: **GO** (see A.6). Build and plumbing verified over adb (A.2); live delivery verified with a second handset (A.6).

### A.1 What was built

- Local Expo module `modules/sms-ingest/` (autolinked from `modules/`): `expo-module.config.json`, `android/build.gradle`, `android/src/main/AndroidManifest.xml`, Kotlin `SmsReceiver` and `SmsIngestModule`, `src/index.ts`.
- Manifest: `RECEIVE_SMS` and `POST_NOTIFICATIONS`; `<receiver expo.modules.smsingest.SmsReceiver android:exported="true" android:permission="android.permission.BROADCAST_SMS">` with an `android.provider.Telephony.SMS_RECEIVED` filter (priority 999). Merged into the app manifest by Gradle.
- The spike `SmsReceiver` ran no JavaScript (works with the process dead). On each SMS it appended `{sender, body, ts}` to SharedPreferences file `sms_ingest_spike`, key `queue`, then posted a notification on channel `sms_spike` ("Spike: SMS from <sender> (<n> chars)", no body). It accepted any sender; Task 9 replaced it (section C) and deletes the spike file on first load.
- Spike `SmsIngestModule` (JS name `SmsIngest`): `requestPermissions()`, `hasPermission()`, `peekQueue()`; `app/index.tsx` was a throwaway screen with "Request SMS permissions" and "Show queue". Both replaced in Task 9.

### A.2 Verified on the phone without a second handset (CPH2487, 2026-11-08)

- Debug APK built and installed; `dumpsys package` shows `app.onebook.autoledger/expo.modules.smsingest.SmsReceiver` registered for `android.provider.Telephony.SMS_RECEIVED`, priority 999.
- `RECEIVE_SMS` and `POST_NOTIFICATIONS` appear in the requested permissions.
- `adb shell pm grant` is NOT allowed on this phone (`GRANT_RUNTIME_PERMISSIONS` SecurityException): permissions must be granted by tapping the in-app request on the phone. Before that, both were `granted=false`; `RECEIVE_SMS` carries flag `RESTRICTION_INSTALLER_EXEMPT`. **No ColorOS setting was needed beyond granting the permission via the in-app request** (no "Allow restricted settings", battery or autostart change was made for the A.6 results).
- Queue file absent before the first SMS, as expected.
- `npm test`: 193 passed; `npm run typecheck` clean.

### A.3 How the spike results were read

```
adb shell run-as app.onebook.autoledger cat shared_prefs/sms_ingest_spike.xml
adb shell dumpsys notification --noredact | grep -A8 app.onebook.autoledger
```
The notification and the private queue file are the evidence that the receiver ran while the app was dead. The queue holds message text: do not paste real SMS bodies into the repo. (Production paths are in section C.)

### A.4 ColorOS menu names seen on the phone (App info for AutoLedger)

Open via `adb shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:app.onebook.autoledger`, or long-press the icon > App info.
- Manage notifications (value "Don't allow" until the notification permission is granted); Permissions.
- **Battery usage**, opening "Power consumption control" with three options: **Allow background activity**, **Smart mode (Recommended)** (the default, selected on this phone), **Restrict background activity**.
- Data usage ("Background data" switch, on); Storage usage; Open by default; **Manage app if unused** (switch, ON by default; it can revoke permissions and hibernate an unused app, so onboarding should suggest turning it OFF); Display over other apps.
- No "Autostart" entry was visible on this App info page. None of these settings were changed for the results in A.6.

### A.5 Test procedure used (user + controller, second handset)

Preparation: open the app, grant SMS and notifications through the in-app request. Note the second handset's number (never commit it). One SMS per scenario with a unique text. `am force-stop` is never used: the swipe-away is the real test. Battery setting stays at the default (Smart mode).

| # | Scenario | Steps |
|---|----------|-------|
| 1 | App in foreground | App open on its screen, screen on. Send SMS. |
| 2 | App in background | Press Home (app still in recents), screen on. Send SMS. |
| 3 | Swiped away, screen on | Open recents, swipe AutoLedger away, screen on. Send SMS. |
| 4 | Swiped away, screen off | Swipe away, lock the screen, wait (about 1 min for 4b, about 12 min for "idle"), send SMS, then wake the phone. Check notification and queue file. |
| 5 | Swiped away + background activity allowed | Only if 3 or 4 fail: App info > Battery usage > Allow background activity; Manage app if unused OFF. Not needed (see A.6). |

### A.6 Results (2026-11-08, Oppo/OnePlus CPH2487, ColorOS, default "Smart mode" background setting, debug build, sideloaded)

Method: plain SMS from a second handset; results read over adb from the app's private queue file (`run-as`), the notification list, and the process start time versus the SMS timestamp. `am force-stop` was never used.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | App open in foreground | PASS | message stored, notification on `sms_spike` channel |
| 2 | App in background (Home) | PASS | launcher was the resumed activity; message stored |
| 3 | Swiped away, screen on | PASS (inferred) | process started 2-3 s after the SMS timestamp with the launcher in front |
| 4b | Swiped away, screen off about 1 min | PASS | process confirmed dead before the SMS (screen Dozing); process start matched the SMS |
| 4-idle | Swiped away, screen off about 12 min | PASS | process checked dead every minute for 10 min; message stored, process started at the SMS time |

Notes: a first attempt returned nothing because the message was sent as RCS/chat, not SMS (not delivered to the SMS inbox at all); send test messages as plain SMS. A test where the app had not actually been swiped away (process still alive from the previous SMS) was discarded as inconclusive. Real bank alerts are plain SMS. Scenario 5 ("Allow background activity") was not needed.

Steps the user must take on ColorOS (feeds Task 16 onboarding copy): grant SMS and notification permissions through the in-app request. Nothing else was required on this phone; suggesting "Manage app if unused: OFF" is a precaution, not a measured need.

**Go/no-go: GO.** The Kotlin broadcast receiver inside the Expo module receives SMS on this phone when the app has been swiped away and has been idle for about 12 minutes. Not tested: a reboot, battery-saver mode, deep overnight idle, other OEMs (Samsung/Xiaomi), and a release (non-debug) build.

### B.14 Pay without paid_to (live check, Task 12)

Run on stage (2026-11-08) with bodies produced verbatim by `planAction`; every draft was deleted afterwards (list queries by reference confirmed nothing remained).

- Payment Entry Pay, Supplier, **no `paid_to`**, paid from the bank GL: `200`, draft, server set `paid_to = Creditors - ZP`. Same from the card GL (`paid_from = IDFC Credit Card - ZP`): `200`, `paid_to = Creditors - ZP`.
- Payment Entry Pay, Employee (HR-EMP-00001), **no `paid_to`**: `200`, draft, server set `paid_to = Payroll Payable - ZP` (the right account for salary). Passing `paid_to = Creditors - ZP` for the Employee was also accepted, but is the wrong account, so the planner deliberately omits `paid_to` on Pay entries.
- Company default payable account is `Creditors - ZP`. Result: no planner change needed (no `payableAccount` in `PlanContext`).
- `bill_paid_by_card` references row path: not live-tested against a real invoice (stage had no submitted Purchase Invoice with outstanding > 0, and invoices must not be submitted on stage). A reference to a nonexistent invoice is rejected: `417 LinkValidationError "Could not find Row #1: Name: PINV-NONE"`; the body shape was otherwise as in B.5.
- Journal Entry with `party_type: Supplier` + `party` on the **expense debit row** (`Administrative Expenses - ZP`), credit the card GL: `200`, draft, party fields stored on the row as sent. Kept in the planner.

## C. Production receiver verification procedure (Task 9)

Run by the controller with the user, the pilot phone (over adb) and a second handset. The controller installs the debug APK (`android/app/build/outputs/apk/debug/app-debug.apk`; the phone shows an install-approval prompt). Never commit the second handset's number, real SMS bodies or screenshots containing them. Send every test message as **plain SMS**, not RCS/chat (see A.6 notes).

Package `app.onebook.autoledger`. Shorthand used below: `P=app.onebook.autoledger`.

Where the production receiver keeps its state (app-private; `android:allowBackup="false"`; queue in `no_backup/`):

| What | Path (relative to the app data dir) |
|---|---|
| Queue (JSON `{v, seq, items[]}`; each item `{id, sender, body, receivedAt, kind}`) | `no_backup/sms-ingest/queue.json` |
| Dropped-when-full counter (bound 500) | `no_backup/sms-ingest/dropped` |
| Sender patterns | `no_backup/sms-ingest/sender_patterns.json` |
| Quarantined corrupt files | `no_backup/sms-ingest/*.corrupt-<epoch ms>` |
| Template override (from `setTemplates`) | `files/templates/idfc.json` |

```
adb shell run-as $P ls -la no_backup/sms-ingest files/templates shared_prefs
adb shell run-as $P cat no_backup/sms-ingest/queue.json
adb shell run-as $P cat no_backup/sms-ingest/sender_patterns.json
adb shell dumpsys notification --noredact | grep -B2 -A14 "pkg=$P"
adb shell dumpsys notification | grep -A3 "transactions"
adb shell dumpsys package $P | grep -E "pkgFlags|privateFlags|ALLOW_BACKUP"
adb shell dumpsys package $P | grep -E "RECEIVE_SMS|READ_SMS|POST_NOTIFICATIONS"
adb shell dumpsys package $P | grep -B1 -A4 "SMS_RECEIVED"
adb shell pidof $P          # empty = process dead
```

Why the test needs the "extra pattern" and "test templates": the receiver only stores SMS from configured sender patterns (`IDFCFB` in production), and the template engine only parses senders whose `senderPattern` is in the template set. A second handset's sender is a phone number, so on the debug screen the user enters a substring of that number (for example its last 6 digits) as the extra pattern, taps **Set sender patterns** (patterns become `IDFCFB` + extra), and taps **Use test templates** (stores, through the normal `setTemplates` path, the bundled IDFC templates with one more bank entry whose `senderPattern` is the extra pattern). No receiver code path treats test senders specially.

### C.1 Setup and static checks

1. Install the APK (controller). Open the app: the "Receiver test (debug)" screen appears.
2. Tap **Request permissions**; allow SMS (one dialog may cover receive and read) and notifications. The output shows `{"receive":true,"read":true,"notifications":true}`.
3. Enter the extra pattern; tap **Set sender patterns** (expect `patterns: ["IDFCFB","<extra>"]`), then **Use test templates** (expect `setTemplates: true; {"source":"override","version":1}`).
4. Tap **Engine health and templates**: expect `health.usable: true`, `reason: "ok"`, `templates.source: "override"`, `dropped: 0`. If `usable` is false, stop: SMS would be stored unparsed and no notifications posted.
5. `dumpsys package`: `pkgFlags` must NOT contain `ALLOW_BACKUP`; `RECEIVE_SMS`, `READ_SMS`, `POST_NOTIFICATIONS` requested and `granted=true`; the receiver registered for `SMS_RECEIVED`.
6. `run-as $P ls shared_prefs`: no `sms_ingest_spike.xml` (the Task 2 spike queue is deleted on first load).

### C.2 Message scenarios (app in foreground unless stated; clear notifications between scenarios)

| # | From | Body | Expect |
|---|---|---|---|
| 1 | second handset | `Your A/c XXXXXXX1234 has been credited with Rs. 100.00 on 08-11-2026. Info: NEFT/TEST/ACME TEST TRADERS. New bal: Rs. 1,000.00. Team IDFC FIRST Bank` | Notification on channel `transactions`: title `₹100.00 credited to IDFC First …1234`, text `Tap to classify` (no body text). Queue item `kind: "ca_credit"`. |
| 2 | second handset | `Rs 50.00 debited from your account via a new channel. Team IDFC FIRST Bank` | Queue item `kind: "unrecognised"`; **no** notification. |
| 3 | second handset | `482913 is your OTP for login. Do not share it with anyone.` | Not stored (queue unchanged), no notification. |
| 4 | second handset | `Hello, this is a test message with no money in it` | Not stored, no notification. |
| 5 | second handset, after **Set sender patterns** with the extra field EMPTY (patterns `["IDFCFB"]`) | the body of #1 with `Rs. 105.00` | Not stored, no notification (sender not configured). Afterwards re-enter the extra pattern and tap **Set sender patterns** again. |
| 6 | second handset, app swiped away, screen on | body of #1 with `Rs. 101.00` | Notification `₹101.00 credited to IDFC First …1234`; queue item `ca_credit`; `pidof` shows the process started at the SMS time. |
| 7 | second handset, app swiped away, screen off about 12 min (check `pidof` empty every minute first) | body of #1 with `Rs. 102.00` | As #6, after waking the phone. |

After each, read the queue with `run-as ... cat no_backup/sms-ingest/queue.json` and the notification with `dumpsys notification --noredact`. Each notification has its own id (derived from the queue item id), so #1, #6 and #7 appear as separate notifications. On the lock screen the notification is PRIVATE: with "hide sensitive content" on, it shows only "AutoLedger / New bank transaction".

### C.3 Tap, queue and backfill

1. Tap a notification: the app opens via the immutable deep link `autoledger://inbox`. Until the Inbox screen exists (Task 17), expo-router shows its "Unmatched Route" screen; the app must not crash. Equivalent adb check: `adb shell am start -W -a android.intent.action.VIEW -d autoledger://inbox $P`.
2. Debug screen **Peek queue**: lists id, sender, kind, receivedAt and body of each stored message (#1, #2, #6, #7; not #3, #4, #5). Peek twice: the list is unchanged (peek never removes).
3. **Backfill 7 days**: shows a count only. Expect the money-like test SMS from the second handset still in the phone's SMS inbox (#1, #2, #5, #6, #7 = 5, plus any real IDFC alerts of the last 7 days), never #3 (OTP) or #4. The queue is not changed by backfill.
4. **Ack all**: `acked N`; **Peek queue** then shows `queue empty`; `queue.json` has `"items":[]`.

### C.4 Cleanup

Tap **Reset templates** (expect `{"source":"bundled","version":1}`), clear the extra field and tap **Set sender patterns** (`["IDFCFB"]`), **Ack all**. Optionally delete the test SMS from the phone's inbox. Record results below with dates, but no numbers or bodies.

### C.5 Results

_Recorded by the controller after the run._
