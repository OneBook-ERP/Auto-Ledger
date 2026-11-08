# Releasing AutoLedger

Release configuration: `eas.json` (build profiles, submit) and `app.json` (`android.versionCode`, `runtimeVersion`). Nothing here has been run: no EAS project exists yet in this repository, and builds, submits and updates are done by the account owner.

## 0. One-time setup (account owner)

```
npm install -g eas-cli          # or use npx eas-cli
eas login
eas init                        # creates the EAS project; writes extra.eas.projectId to app.json
eas update:configure            # writes updates.url (and checks runtimeVersion) in app.json
```

The repository deliberately has no `extra.eas.projectId` and no `updates.url`: those values belong to your Expo account and must not be invented. Commit the two lines these commands add to `app.json`.

Play Console: create the app `app.onebook.autoledger` and the internal testing track, upload the first AAB by hand once (Google requires the first upload to be manual [VERIFY IN PLAY CONSOLE]), then create a service account with release permission, download its JSON key and keep it outside the repository. Set `submit.production.android.serviceAccountKeyPath` in `eas.json` to that path (currently `[FILL IN]`).

## 1. Profiles

| Profile | Purpose | Output | Update channel |
|---|---|---|---|
| `development` | dev client with Metro, internal distribution | APK | `development` |
| `preview` | pilot phones: install directly, no Play | APK | `preview` |
| `production` | Play upload; `autoIncrement` raises `versionCode` | AAB | `production` |

`runtimeVersion` is `{ "policy": "appVersion" }`: the runtime version equals `expo.version` in `app.json`. An OTA update (`eas update`) is only delivered to installed builds with the same runtime version. This app has custom native code (`modules/sms-ingest`, expo-secure-store, expo-sqlite), so a JS update must never reach a binary whose native side differs. With `appVersion` you control that by hand: **bump `expo.version` whenever the native side changes** (new native module, changed Kotlin, changed plugin or permission, Expo SDK upgrade) and keep it unchanged for JS-only releases. The alternative `fingerprint` policy automates this but is slower to reason about and needs a fingerprint check in CI; not needed for a single-app pilot. `android.versionCode` (currently 1) must increase on every Play upload; `autoIncrement` in the `production` profile does it with `appVersionSource: local` (it edits `app.json`: commit the change).

Channels are fixed per profile, so an update published to `preview` reaches only preview builds.

## 2. Cut a pilot build (preview APK)

Before the first build and after every change to native code or plugins, remember that **the installed dev client is now stale**: expo-secure-store and the `sms-ingest` module were added after the first dev-client build, so anyone developing against a device must rebuild the dev client:

```
eas build -p android --profile development      # or locally: npx expo prebuild --platform android && cd android && ./gradlew assembleDebug (README, "Android dev client")
```

Pilot build:

```
npm test && npm run typecheck
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :sms-ingest:testDebugUnitTest && cd ..   # needs a prebuilt android/ (git-ignored)
git status                                   # must be clean
eas build -p android --profile preview
```

EAS prints a URL and QR code for the APK. On the pilot phone: open the link, install (allow "install unknown apps" for the browser if asked), open the app, log in, finish setup including the permission step.

Play internal testing (AAB):

```
eas build -p android --profile production
eas submit -p android --profile production       # uploads the latest build to the internal track as a draft release
```

Then in Play Console: Testing > Internal testing: add testers (email list), review the draft release, roll it out, send testers the opt-in link. Release notes: [FILL IN].

## 3. Two kinds of update

### 3a. Template-only update (no app release)

Use when a bank changes its SMS wording or a new format appears. The parser rules are data in `templates/idfc.json`.

1. Edit `templates/idfc.json`. Raise `"version"` (a positive integer; the app only accepts a set whose version is greater than the active one).
2. Add the redacted SMS to `fixtures/sms/idfc.json` (see `fixtures/sms/README.md`) with its expected result.
3. `npm test`: the fixtures conformance test runs every fixture through the TypeScript engine. Run the Kotlin engine over the same fixtures:
   ```
   cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :sms-ingest:testDebugUnitTest
   ```
   Both engines must pass: the receiver parses in Kotlin when the app is not running, the app parses in TypeScript.
4. `npx tsx scripts/pilot-parse-rate.ts` should still report >= 95%.
5. Host the file at an https URL you control (a static file on a CDN, GitHub Pages or object storage; no redirects to http; 256 KB maximum; content-type JSON). The URL is compiled into the app as `TEMPLATES_URL` in `src/state/config.ts`, **currently an empty string, so remote refresh is disabled in every build made today**. To turn it on: set `TEMPLATES_URL` to the final URL (for example `https://<your-cdn>/autoledger/idfc.json`), and ship that once as a **code update/new build** (section 3b). From then on templates update without a release.
6. Publish by replacing the hosted file. The app checks at most once every 24 hours (`src/state/templatesSchedule.ts`), when it runs its scheduled work.

What the app does with a fetched set (`src/ingest/templates.ts`): https only, 10 s timeout, 256 KB cap; version must be newer; every regex must compile, avoid features that differ between JS and Java, and use only known capture groups; six built-in synthetic SMS (credit, debit, NEFT, card spend, card SI, OTP) must parse to the expected values in TypeScript; then the Kotlin engine validates the set again and must accept it; only then is the set saved. **On any failure the previously active set (or the bundled one) stays in use** and nothing is shown to the user. A set whose version is not greater than the bundled one is ignored on the next start.

Risk to know: the built-in checks do not prove your new regexes parse real messages. Steps 2 to 4 do. Do not skip them.

### 3b. Code update

| Change | Mechanism | Why |
|---|---|---|
| JS/TS, styles, copy in `src/` or `app/`, no new native dependency, no change under `modules/`, no change to `app.json` plugins/permissions | `eas update --channel preview --message "<what>"` (then `--channel production` after the pilot accepts it) | Delivered over the air to builds with the same `runtimeVersion`. |
| New or changed native module, Kotlin change, Android manifest or permission change, new Expo package with native code, Expo SDK upgrade, `app.json` plugin change | Bump `expo.version`, `eas build -p android --profile preview` (and `production` for Play) | Native code only changes with a new binary; OTA cannot carry it. |
| `TEMPLATES_URL` change | It is a TS constant: JS-only, so `eas update` is enough if the installed runtime matches | |
| Template JSON only | Section 3a | No release needed once `TEMPLATES_URL` is set. |

Decision rule: if `git diff <last-released-tag>..HEAD -- modules android app.json package.json` shows nothing that affects native code, it is a JS update; otherwise rebuild. When unsure, rebuild.

## 4. Rollback

- **Template update:** put the previous JSON back at the URL **with a higher `version`** (versions only go up: if you republish the old content as the same or lower version the app will keep the bad newer set). Then devices fetch it within 24 hours. There is no in-app reset of the stored template set; the options on one phone are waiting for the corrected higher version, installing a build whose bundled version is higher, or clearing the app data as a last resort (this also clears the local queue and Activity).
- **JS update:** `eas update:republish --channel preview` (pick the previous update from the list), or publish a fix with `eas update --channel preview`. `eas update:rollback` removes the latest update so devices fall back to the embedded bundle. [VERIFY with `eas update --help` for your eas-cli version.]
- **Native build:** the previous APK stays available in the EAS build list; reinstall it (Android refuses a downgrade of `versionCode` unless the app is uninstalled first, which deletes local data: warn testers). On Play, halt the rollout and release the previous build again with a higher `versionCode`.
- **Drafts already created by a bad build:** they remain drafts in ERPNext. Find them with `scripts/pilot-duplicates.ts` (stage only) or the ERPNext list view filtered by creation time; delete in ERPNext, or use Undo in the Activity screen while they are still drafts.

## 5. What the founder or accountant sees when a template update arrives

Nothing. There is no banner, no restart and no notification: the new rules apply to the next SMS the app parses. The visible effects are indirect: a message format that was previously counted as "unrecognised" now appears in the Inbox as a normal transaction, and the Settings or Home screens show a different template version where the app displays it [FILL IN: confirm after Task 17 merge whether the version is shown anywhere]. If a fetched set is rejected, they see nothing at all. Tell the pilot users in the release message when a format fix is expected, so the new items appearing in the Inbox are not a surprise. Messages already stored as "unrecognised" before the fix are not re-parsed automatically: backfill (opening the app) reads the last 7 days from the inbox again, and the dedupe by `rawHash` means nothing is created twice.
