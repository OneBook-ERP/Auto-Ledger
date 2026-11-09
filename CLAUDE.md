# AutoLedger (OneBook Automated Reconciliation App)

Android app that reads bank/credit-card SMS (IDFC First is the pilot bank), asks the user ONE question per transaction, and creates **draft** ERPNext records (Payment Entry / Journal Entry) on a **vanilla** ERPNext site (no custom app, no server of ours). A trust-labelled Home shows bank balance, receivables, payables and drafts waiting for the accountant. The accountant submits drafts and reconciles in ERPNext. No AI in phase 1. Bank Transaction creation is phase 2.

Read first: `docs/CONTEXT.md` (status, decisions, known limitations, what is next), then `docs/superpowers/specs/2026-11-08-autoledger-design.md` (approved spec) and `docs/spike-report.md` (ERPNext API facts, receiver results).

## Hard rules (never break)
- Writes go ONLY to the stage site. Production (`atom.onebook.app`) is read-only and only when the user asks.
- Only create DRAFTS (`docstatus` 0). Never submit. No Bank Transaction in phase 1.
- Credentials live only in git-ignored `.env.local` (`ONEBOOK_STAGE_URL/KEY/SECRET`). Never commit, print or log them. The app never stores the password.
- Raw SMS text never leaves the device and is never persisted by the app (only parsed fields). No raw SMS in logs, crash reports or tests.
- Do not push to GitHub without the user's explicit go-ahead. History must be cleaned first (a real counterparty name is in an early commit) and the repo's privacy decided.
- Money logic is exact: integer minor units (paise) everywhere in `src/core`; no floats for amounts.
- Never `git add -A` in a worktree (`node_modules` is a symlink there). Add files by name.

## Stack
Expo SDK 58 / React Native 0.88 / TypeScript / Expo Router / NativeWind v4 / expo-sqlite / expo-secure-store / TanStack Query / Zustand / Lucide icons (`react-native-svg`). Jest (`jest-expo`) + React Native Testing Library. A local Expo module in Kotlin, `modules/sms-ingest` (BroadcastReceiver, `goAsync`, queue in `noBackupFilesDir`, template engine, minSdk 26, `allowBackup` false).
Shared JSON parser templates `templates/idfc.json` drive BOTH the TypeScript parser (`src/core/parser/engine.ts`) and the Kotlin parser. Regexes must be valid in JS and Java (no inline flags, group names letters+digits only, case-insensitive via flags). Fixtures in `fixtures/sms/idfc.json` are append-only.

## Layout
- `src/core` pure TS: parser, correlate, plan (action to ERPNext document steps), suggest, trust. No I/O.
- `src/data` repo over a `SqlDriver` (mutex, upserts, outbox, settings, site binding).
- `src/erp` thin typed `fetch` client, auth, docs (drafts, parties, accounts), reports.
- `src/outbox` runner (idempotent, compensation, per-txn lock, adoption rules, undo) and ERP ops.
- `src/ingest` pipeline (peek/ack, backfill 7 days, merge), drainer, template refresh, status poller.
- `src/state` AppProvider, session, setup wizard model, cycle, Sentry (off by default) and scrubber.
- `src/home`, `src/inbox`, `src/ui` view-models, flow state and the component kit (`src/ui/Icon.tsx` owns the icon set).
- `app/` Expo Router screens: `(auth)`, `(setup)`, `(tabs)` (home, inbox, activity, settings), `txn/*` (answer flow), `debug-receiver` (dev only).
- `docs/` spec, plan, spike report, release/pilot docs, UI audit. `scripts/` pilot analysis scripts.

## Commands
```bash
npm install
npx tsc --noEmit            # typecheck (must be clean)
npx jest                    # full suite (about 1,230 tests, 3 skipped)
npx expo start              # Metro for the dev client
# Native rebuild + install on the phone (needed only when native deps/modules change):
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH=/opt/homebrew/opt/openjdk@17/bin:$PATH
npx expo run:android --device <ip:port> --no-bundler
# Kotlin unit tests:
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :sms-ingest:testDebugUnitTest --offline
```
The phone (Oppo CPH2487) is used over wireless debugging: `adb connect <ip:port>` (the port changes each time Wireless debugging is toggled). The Oppo shows an install-guard prompt that the user must approve on the phone. Inspect the app DB with `adb exec-out run-as app.onebook.autoledger cat files/SQLite/autoledger.db`.
In a git worktree the repo jest config ignores `/.superpowers/`: use a temp config outside the repo (copy of `jest.config.js` with `rootDir` = the worktree, `modulePathIgnorePatterns: []`).

## Conventions
- Indentation: 2 spaces for TS/TSX/JSON/MD/YAML, 4 for Kotlin and Gradle (see `.editorconfig`). LF line endings, final newline, single quotes, semicolons, trailing commas in multiline literals, width about 140.
- Strict TypeScript. Prefer small pure functions and view-models with tests; screens stay thin.
- Copy for users: plain language for a non-accountant business owner, sentence case, no em dashes, no jargon as primary text (no "UTR", "Debit/Credit", doctype names or document ids). Same date format everywhere (`8 Nov 2026`) and a true minus `−` for money out.
- Light AND dark themes must both work: colours come from NativeWind tokens (`tailwind.config.js`), never one-theme literals. Touch targets at least 48 dp. Icons are decorative and always sit beside a text label.
- Tests: write the test first for new logic; in async RNTL tests always `await render`, `await unmount`, `await fireEvent`.
- Commits: `type(scope): summary` (feat, fix, test, docs, chore, perf, merge). End AI-written commits with the `Co-Authored-By` line required by the session.
- Screens import icons only through `src/ui` (`Icon`); add a name to `ICONS` before using a new one.

## ERPNext facts that bite (v16 stage; details in `docs/spike-report.md` B)
`generate_keys` needs System Manager (paste-key fallback exists). `get_balance_on` is not whitelisted: the balance is a GL SUM via `frappe.client.get_list`. `mode_of_payment` is mandatory on a Payment Entry. A Journal Entry `cheque_no` needs `cheque_date`. Reference fields: `reference_no` (PE), `cheque_no` (JE). Closed periods are detected by `exc_type`. Path segments must be encoded (`encodeSegment`). Only Bank Accounts flagged **Is Company Account** are offered in setup.

## Working with agents here
Plans and the review ledger live in `docs/superpowers/plans/` and (local, git-ignored) `.superpowers/sdd/`. Parallel work uses git worktrees under `.superpowers/wt/<name>` with disjoint file sets, one implementer per group, a review per group, and a controller that merges. Rulings (decisions made while building) are summarised in `docs/CONTEXT.md`.
