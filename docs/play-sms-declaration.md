# Google Play: SMS permission declaration

Ready-to-paste text for the Play Console "Permissions declaration form" (RECEIVE_SMS and READ_SMS). Every factual statement below was checked against the repository on 2026-11-09 (sources in brackets). `[FILL IN]` marks what only the account owner knows; `[VERIFY IN PLAY CONSOLE]` marks policy details that Google may have changed since this was written: read the live form and the "Use of SMS or Call Log permission groups" policy page before submitting.

Package: `app.onebook.autoledger` (app.json). Permissions declared in `modules/sms-ingest/android/src/main/AndroidManifest.xml`: `RECEIVE_SMS`, `READ_SMS`, `POST_NOTIFICATIONS`. No `SEND_SMS`, no `READ_CONTACTS`, no call-log permission.

## 1. Which permissions and why each is needed

| Permission | Used for | Code |
|---|---|---|
| `RECEIVE_SMS` | A broadcast receiver is told when a new SMS arrives, including when the app is not running, so the transaction can be queued and a notification posted. | `SmsReceiver.kt` |
| `READ_SMS` | One-off backfill: when the app is opened it can read the phone's SMS inbox for a period the user chooses (1 week by default, up to 6 months or all time), from the configured bank senders only, to catch alerts that arrived while the phone was off or the app lacked permission. It does not read the inbox continuously and does not read other senders. | `SmsIngestModule.kt` (`backfill`), `Ingest.kt` (`MessageClassifier.keep`) |

## 2. Core functionality statement (paste into "core functionality")

> AutoLedger is a bookkeeping app for small businesses that use ERPNext. Its core function is to turn the user's own bank and credit-card transaction alerts, which banks send by SMS, into draft accounting entries in the user's own ERPNext site. The SMS alert is the only source of the transaction (amount, date, account, reference); without access to it the app cannot do its single purpose. For each alert the app asks the user what the money was for (for example "payment from a customer") and only after the user confirms creates a DRAFT document in ERPNext, which the accountant reviews. The app does not send, delete or modify SMS and does not read personal conversations.

## 3. Why the default SMS handler is not applicable (paste)

> AutoLedger is not a messaging app. It does not send or compose SMS, does not show conversations and does not replace the user's messaging app, so it does not and cannot be the default SMS handler. It needs RECEIVE_SMS (and READ_SMS for a catch-up over a period the user chooses) because receiving the bank alert is its core function and no other API provides the content of an incoming bank alert. [VERIFY IN PLAY CONSOLE: the form lists "default SMS handler" exceptions; pick the one matching "other core functionality" if it is offered.]

## 4. Exactly which messages are read (paste)

> The app reads a message only if its sender id contains a bank sender id that the user configured during setup (for the pilot: IDFCFB, which matches sender ids such as JM-IDFCFB-S). The user's bank accounts and their sender ids are saved in the app in the setup step before the permission request. The receiver compares the sender with this list first; a message from any other sender is ignored immediately, before anything is stored, and its text is not examined. One-time-password (OTP) messages from a configured sender are dropped next, before storage. Messages that are not about money (marketing, KYC, limit alerts, statements) are dropped too.

Code: `MessageClassifier.classify` in `Ingest.kt` applies, in this order: sender filter, OTP check, template parse, money-like check, else drop. Sender patterns come from the user's account mappings (`syncSenderPatterns` in `src/ingest/pipeline.ts`).

## 5. Processing, storage and retention (paste, then see the table)

> All reading and parsing happens on the device by code inside the app. The raw SMS text is never sent to any server, including the developer's. After a message is understood, the app keeps only parsed fields on the phone: amount, currency, date and time of the transaction, the last 4 digits of the account or card, a reference number if the SMS states one, the counterparty or merchant name if stated, the account balance shown in the SMS if any, the sender id (for example IDFCFB) and the time the SMS was received. When the user confirms what a transaction was for, only a subset is sent, over HTTPS, to the user's own ERPNext site: the amount, the transaction date, the reference (the bank's reference number, or an app-derived code of the form AL-<number> when the SMS has none), the counterparty or merchant name (in the remarks field), and the accounts and party the user chose. The account balance, the sender id, the received time, the transaction time and the last 4 digits are never sent.

| Where | What is held | For how long | Source |
|---|---|---|---|
| Native queue `no_backup/sms-ingest/queue.json` (app-private, excluded from Android backup because `allowBackup` is false) | For each accepted message: sender id, **full text**, receive time, kind. This is the only place the raw text is kept. | Until the app has processed the message and acknowledges it (`ack`), which happens in the same run in which the app is opened or the pipeline drains. The queue holds at most 500 items; beyond that the oldest are dropped and counted. | `SmsQueue.kt`, `src/ingest/pipeline.ts` |
| Quarantine `queue.json.corrupt-<time>` | If the queue file cannot be parsed it is moved aside whole (still containing any raw text it had) and the queue starts empty. | Kept until the app data is cleared or the app is uninstalled. There is no automatic deletion. [FILL IN: decide whether a purge is needed before release; today none exists.] | `SmsQueue.kt`, `KeyValueStore.quarantine` |
| SQLite `pending_txn` (app-private) | Parsed fields only; no SMS body column. Columns: kind, direction, amount, currency, occurred_on (date), occurred_time, account_type, account_last4, counterparty, utr (reference), merchant, **balance_minor (the account balance stated in the SMS)**, **sender (the sender id)**, **received_at**, plus app state (state, created document names, error text). The SMS is identified by `raw_hash`, a non-cryptographic hash of sender and normalised text; it is also what the derived `AL-` reference is built from. Learned rules (table `rule`) keep a counterparty/reference key and the chosen action, party and account. | Until the app is uninstalled or data is cleared; the user's Activity list shows them. | `src/data/schema.ts` |
| Notifications | Amount, bank name and the last 4 digits of the account (for example "... 1234"), and "Tap to classify"; never the SMS text. On the lock screen only "AutoLedger / New bank transaction" is shown. | Until dismissed. | `NotificationPoster.kt`, spike report section C.5 |
| The user's ERPNext site | Draft Payment Entry or Journal Entry: company, posting date (the transaction date), mode of payment, amount, `reference_no`/`cheque_no` and its date, `remarks`/`user_remark` = "AutoLedger | <counterparty or merchant>" (plus a foreign-currency note for foreign spends), and the party/accounts the user chose. Not sent: balance, sender id, received time, transaction time, account last 4. The reference is also sent in read queries that look for an existing document with the same reference (duplicate check), and the counterparty name prefills the customer/supplier search box, so it is sent as a search term to the user's site when the user searches. | Under the user's control in ERPNext. | `src/core/plan.ts` |

Messages stored as "unrecognised" (money-like text in a format the parser does not know) also sit in the native queue with their full text until acknowledged, and are shown to the user only as a count. They are not sent anywhere.

## 6. Data safety form answers [VERIFY IN PLAY CONSOLE: question wording changes]

| Question | Answer | Basis |
|---|---|---|
| Does the app collect or share any required user data types? | Yes, collects; does not share with third parties. | |
| Data type: "SMS or MMS" (Messages) | **Collected: yes** (read on device). **Shared: no.** Processed ephemerally: the raw text is processed on the device and is not transmitted off the device. [VERIFY IN PLAY CONSOLE: if the form defines "collected" as transmitted off the device, this may be answerable as not collected; decide with the account owner.] Purpose: App functionality. Optional: no (core function). | Sections 4 and 5 |
| Data type: "Financial info: other financial info" (transaction amount, date, reference; the account balance and last 4 digits of the account are read and stored on the phone only) | Collected: yes. Shared: no with third parties; it is sent to the user's own ERPNext site, which the user configures and controls (a user-directed transfer to their own account; [VERIFY IN PLAY CONSOLE] how to classify). Purpose: App functionality. | `src/erp/*` |
| Data type: "Personal info: name / user IDs" (counterparty names in the SMS, ERPNext login) | Name: the parsed counterparty or merchant name is sent to the user's own ERPNext. Credentials: API key and secret stored in the Android Keystore through expo-secure-store; the password is not stored. | spec section 15 |
| Crash logs / diagnostics | Crash reporting is [FILL IN: enabled/disabled in the release build]; when enabled, events are scrubbed of amounts, references and message text before sending. Answer the crash-logs question accordingly. This is finalised in a later docs-sync. | spec section 15: "no financial data in crash reports" |
| Is all data encrypted in transit? | Yes. The site URL must be https; plain HTTP is rejected except in debug builds. Template updates are fetched over https only. | `src/erp/client.ts` (`normalizeSiteUrl`), `src/ingest/templates.ts` |
| Do you provide a way for users to request deletion? | Local data: the user can sign out (Settings > Sign out forgets the login; entries stay on the phone) or uninstall / clear app data, which removes the queue and database. The developer holds no copy of SMS or transactions. Documents already created in ERPNext belong to the user's site and are managed there; the Activity screen offers Undo for drafts the app created. [FILL IN: a support contact/URL for deletion requests, and a privacy policy URL.] | `app/(tabs)/settings.tsx` |
| Privacy policy URL | [FILL IN] (required for apps requesting SMS permissions). | |

## 7. In-app prominent disclosure (must match the app exactly)

Shown before the Android permission dialog, on the setup step "Permissions" (step 4 of 4), by `app/(setup)/permissions.tsx`. The "Continue" button is the only way forward; the permission request is made after it is tapped.

Title: **How AutoLedger uses your messages**
Subtitle: "Before Android asks for permission, here is exactly what AutoLedger does with it."

1. It reads only text messages from the bank senders you set up in the last step, and only from the period you choose below. You can change it later in Settings.
2. Messages are read and understood on this phone. The raw text never leaves the phone.
3. One-time passwords (OTPs) are ignored and never stored.
4. Only the amount, date and a few details of each transaction are kept, to ask you what it was for. Transaction details go only to your own ERPNext site.

These strings are the exported constants `DISCLOSURE_TITLE` and `DISCLOSURE_POINTS`; if the screen copy changes, change this section in the same commit. `__tests__/setup.test.tsx` checks that the copy does not fix the period at 7 days.

### Differences between the app copy and the Play text (report, do not paper over)

1. Disclosure point 1 now covers the READ_SMS backfill: it states that only the senders you set up are read and only for the period you choose (1 week, 1 month, 3 months, 6 months or all time; default 1 week; all time reads the newest 5,000 matching messages), changeable in Settings. The setup step shows the choice under the disclosure before the Continue button.
2. Point 3 says OTPs are "never stored". True for the native queue and the database (`Ingest.kt` drops them before `append`). Not verified on hardware: spike report C.5 row "C.2 #3 OTP-like message: NOT VERIFIED ON DEVICE" (covered by JUnit classifier tests only).
3. Point 4 says only the amount, date and a few details are kept. True of the database; the native queue briefly holds the full text of accepted messages until acknowledged (section 5). The Play text above says so explicitly; the app copy is a simplification. Consider "kept" -> "kept long term".
4. "The last step" assumes the account step precedes permissions, which it does (`step 4 of 4`; accounts step before).

## 8. Reviewer evidence checklist

Prepare before submitting, using the preview APK on a real phone with a test bank sender. No real SMS content, phone numbers or account numbers in any screenshot.

- [ ] Screenshot: setup "Permissions" step showing the disclosure title and the four points, before any system dialog.
- [ ] Screenshot: the Android system dialog for SMS permission appearing after tapping Continue.
- [ ] Screenshot: Settings screen with the "Grant SMS permission" button (the user can grant later).
- [ ] Screenshot: the sender-id list configured in setup (account step).
- [ ] Screenshot: a notification "Tap to classify" with no SMS text; Inbox row; the Confirm screen "Check before creating"; Activity row after creation.
- [ ] Screenshot: ERPNext Payment Entry in Draft state with the reference.
- [ ] Short video (section 9), uploaded to a public or unlisted link [FILL IN: URL] and pasted in the form.
- [ ] Privacy policy URL [FILL IN] reachable without login; it must repeat sections 4, 5 and 6.
- [ ] Test account for reviewers if the form asks: a stage ERPNext site URL and credentials supplied through the Play Console "App access" instructions, never in this repo. [FILL IN]

## 9. Demo video script (about 90 seconds, screen recording of a real phone)

1. (0:00) Fresh install, open the app. Narration: "AutoLedger turns bank SMS alerts into draft ERPNext entries."
2. (0:10) Log in with the demo site; walk the setup steps to the account step; show the bank sender id configured.
3. (0:25) Permissions step: pause on the disclosure text, read the four points. Tap Continue. Show the system SMS permission dialog; allow.
4. (0:40) Send a test bank-style SMS from another phone (or use a real alert). Show the notification: amount only, no message text.
5. (0:50) Open the app: Inbox shows the item. Tap it, choose an action, confirm. Show "Check before creating" then Create draft.
6. (1:10) Show the draft in ERPNext, with the same reference. State: "The SMS text never left the phone."
7. (1:20) Send an OTP-style SMS and a message from a sender not configured: show that nothing appears in the Inbox.
8. (1:30) Settings: show "Grant SMS permission" and "Sign out".

## 10. If the declaration is rejected

1. Read the rejection email; the usual reasons are (a) the disclosure does not cover the inbox read for the chosen period, (b) the core functionality text sounds like a convenience feature, (c) no privacy policy, (d) the video does not show the disclosure before the permission dialog. Fix the specific point (for (a), change the app copy and ship a new build), resubmit. [VERIFY IN PLAY CONSOLE: the appeal and resubmission options.]
2. Remove READ_SMS only if needed: the app works without the backfill, using RECEIVE_SMS alone (the backfill returns an empty list when READ_SMS is not granted: `SmsIngestModule.kt`). This needs a build change in the module manifest and a reduced disclosure.
3. Alternative distribution while the declaration is open (the pilot does not need the Play production track):
   - Internal testing track: build with `eas build -p android --profile production` and `eas submit` to the internal track. [VERIFY IN PLAY CONSOLE: whether restricted permissions block internal testing releases; as of writing they do not require the declaration for internal testing, but confirm.]
   - Or sideload the `preview` APK (`docs/release.md`) onto the pilot phones, outside Play. Android may show "restricted settings" prompts for sideloaded apps on some devices (spike report A.2: none was needed on the pilot phone; the RECEIVE_SMS flag was `RESTRICTION_INSTALLER_EXEMPT`).
   - Or Play "closed testing" with the pilot customers' Google accounts. [VERIFY IN PLAY CONSOLE]
