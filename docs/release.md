# Releasing AutoLedger

Release configuration: `eas.json` (build profiles, submit) and `app.json` (`android.versionCode`, `runtimeVersion`). Nothing here has been run: no EAS project exists yet in this repository, and builds and submits are done by the account owner.

## 0. One-time setup (account owner)

```
npm install -g eas-cli          # or use npx eas-cli
eas login
eas init                        # creates the EAS project; writes extra.eas.projectId to app.json
```

The repository deliberately has no `extra.eas.projectId`: it belongs to your Expo account and must not be invented. Commit the line `eas init` adds to `app.json`.

**Pilot v1 ships without over-the-air code updates.** `expo-updates` is not in `package.json`, so `eas update` has nothing to talk to in the installed app. Code changes ship as a new build (section 2); parser changes ship through the template-only path (section 3a). Optional later step, section 6.

Play Console: create the app `app.onebook.autoledger` and the internal testing track, upload the first AAB by hand once (Google requires the first upload to be manual [VERIFY IN PLAY CONSOLE]), then create a service account with release permission, download its JSON key and keep it outside the repository. Set `submit.production.android.serviceAccountKeyPath` in `eas.json` to that path (currently `[FILL IN]`).

## 1. Profiles

| Profile | Purpose | Output | `channel` field in eas.json (inert until section 6) |
|---|---|---|---|
| `development` | dev client with Metro, internal distribution | APK | `development` |
| `preview` | pilot phones: install directly, no Play | APK | `preview` |
| `production` | Play upload; `autoIncrement` raises `versionCode` | AAB | `production` |

`app.json` sets `runtimeVersion: { "policy": "appVersion" }` and `eas.json` gives each profile a `channel`. **Both are inert today**: without `expo-updates` in the app they have no effect on the build. They are prepared for the optional OTA step in section 6, where the runtime version must equal `expo.version`, so you would bump `expo.version` whenever native code changes (new native module, changed Kotlin, plugin or permission change, Expo SDK upgrade) and leave it for JS-only releases. (`fingerprint` is the automatic alternative policy; not needed for a single-app pilot.) `android.versionCode` (currently 1) must increase on every Play upload; `autoIncrement` in the `production` profile does it with `appVersionSource: local` (it edits `app.json`: commit the change). For APKs sideloaded over an older install, also raise `versionCode` by hand, because Android refuses an install with a lower or equal one.

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

1. Edit `templates/idfc.json`. Raise `"version"` (a positive integer, strictly greater than the version of the set currently active on the phones: see the two rules below).
2. Add the redacted SMS to `fixtures/sms/idfc.json` (see `fixtures/sms/README.md`) with its expected result.
3. `npm test`: the fixtures conformance test runs every fixture through the TypeScript engine. Run the Kotlin engine over the same fixtures:
   ```
   cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :sms-ingest:testDebugUnitTest
   ```
   Both engines must pass: the receiver parses in Kotlin when the app is not running, the app parses in TypeScript.
4. `npx tsx scripts/pilot-parse-rate.ts` should still report >= 95%.
5. Host the file at an https URL you control (a static file on a CDN, GitHub Pages or object storage; no redirects to http; 256 KB maximum; content-type JSON). The URL is compiled into the app as `TEMPLATES_URL` in `src/state/config.ts`, **currently an empty string, so remote refresh is disabled in every build made today**. To turn it on: set `TEMPLATES_URL` to the final URL (for example `https://<your-cdn>/autoledger/idfc.json`), and ship that once as a **new build** (section 3b). From then on templates update without a release.
6. Publish by replacing the hosted file. The app checks at most once every 24 hours (`src/state/templatesSchedule.ts`), when it runs its scheduled work.

What the app does with a fetched set (`src/ingest/templates.ts`): https only, 10 s timeout, 256 KB cap; version must be strictly greater than the active version (an equal version is reported 'unchanged' and skipped); every regex must compile, avoid features that differ between JS and Java, and use only known capture groups; six built-in synthetic SMS (credit, debit, NEFT, card spend, card SI, OTP) must parse to the expected values in TypeScript; then the Kotlin engine validates the set again and must accept it; only then is the set saved. **On any failure the previously active set (or the bundled one) stays in use** and nothing is shown to the user. 

Two version rules, both from `src/ingest/templates.ts`:
- Remote refresh (`refreshTemplates`): the fetched set's `version` must be **strictly greater** than the active version (the stored set's version if it is valid and not older than the bundled one, otherwise the bundled version).
- Loading at start (`loadTemplates`): the stored set is used only if it validates and its `version` is **greater than or equal to** the bundled `templates/idfc.json` version; a stored set with a lower version than the bundled one is ignored and the bundled set is used. So after a new build with a higher bundled version, an older stored override stops applying.

Risk to know: the built-in checks do not prove your new regexes parse real messages. Steps 2 to 4 do. Do not skip them.

### 3b. Code change (new build)

| Change | Mechanism |
|---|---|
| JS/TS, styles, copy in `src/` or `app/` | New build: bump `expo.version` if you want a visible version, `eas build -p android --profile preview`, install on the pilot phones; for Play, `--profile production` and `eas submit` |
| New or changed native module, Kotlin, manifest or permission, Expo package with native code, Expo SDK upgrade, `app.json` plugin change | New build, same as above; also rebuild the dev client (`--profile development`) |
| `TEMPLATES_URL` change (a TS constant) | New build |
| Parser rules only (`templates/idfc.json`) | Section 3a, no build, once `TEMPLATES_URL` is set |

There is no JS-only shortcut in pilot v1. When in doubt, build.

## 4. Rollback

- **Template update:** put the previous content back at the URL **with a higher `version`** than the bad one (a remote set must be strictly greater than the active version, so republishing old content under the same or a lower version is rejected and the phones keep the bad set). Then devices fetch it within 24 hours. There is no in-app reset of the stored template set; the options on one phone are waiting for the corrected higher version, installing a build whose bundled version is higher, or clearing the app data as a last resort (this also clears the local queue and Activity).
- **Native build:** the previous APK stays available in the EAS build list; reinstall it (Android refuses a downgrade of `versionCode` unless the app is uninstalled first, which deletes local data: warn testers). On Play, halt the rollout and release the previous build again with a higher `versionCode`.
- **Drafts already created by a bad build:** they remain drafts in ERPNext. Find them with `scripts/pilot-duplicates.ts` (stage only) or the ERPNext list view filtered by creation time; delete in ERPNext, or use Undo in the Activity screen while they are still drafts.

## 5. What the founder or accountant sees when a template update arrives

Nothing. There is no banner, no restart and no notification: the new rules apply to the next SMS the app parses. The visible effects are indirect: a message format that was previously counted as "unrecognised" now appears in the Inbox as a normal transaction, and the Settings or Home screens show a different template version where the app displays it [FILL IN: confirm after Task 17 merge whether the version is shown anywhere]. If a fetched set is rejected, they see nothing at all. Tell the pilot users in the release message when a format fix is expected, so the new items appearing in the Inbox are not a surprise. Messages already stored as "unrecognised" before the fix are not re-parsed automatically: backfill (opening the app) reads the last 7 days from the inbox again, and the dedupe by `rawHash` means nothing is created twice.

## 6. Optional later step: over-the-air code updates (EAS Update)

Not part of pilot v1. It needs a native change, so it is a new build for every phone. In order:

1. `npx expo install expo-updates` (adds the dependency at the SDK-matching version). Commit `package.json` and the lockfile.
2. Account owner: `eas update:configure` (needs the project from `eas init`; writes `updates.url` to `app.json`). Commit it.
3. Keep `runtimeVersion` as `{ "policy": "appVersion" }` and `expo.version` unchanged for JS-only releases; bump it on every native change, so an update never reaches a binary with different native code.
4. `npm test && npm run typecheck`, then rebuild the dev client: `eas build -p android --profile development` (or the local Gradle path in the README).
5. Build new pilot binaries: `eas build -p android --profile preview` (and `production` for Play) and install them. Phones keep the old build until they install it; the old build cannot receive updates.
6. From then on a JS-only change ships with `eas update --channel preview --message "<what>"` (then `--channel production`); the `channel` fields in `eas.json` select which builds receive it. Rollback: `eas update:republish` of the previous update, or publish a fix. [VERIFY with `eas update --help` for your eas-cli version.]

Anything touching native code still needs a new build.
