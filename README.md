# AutoLedger

Android app (Expo React Native + TypeScript) that reads bank SMS and creates draft ERPNext entries.
Spec: `docs/superpowers/specs/2026-11-08-autoledger-design.md`. Plan: `docs/superpowers/plans/`.

## Setup

```
npm install
cp .env.example .env.local   # fill in STAGE credentials; never commit
npm test                     # Jest (jest-expo)
npm run typecheck
```

Writes go to the stage site only. `.env.local` is git-ignored.

## Android dev client

Needs JDK 17 and the Android SDK (`brew install openjdk@17 android-commandlinetools`, then
`sdkmanager "ndk;27.1.12297006" "platforms;android-36" "platforms;android-37" "build-tools;37.0.0" "cmake;3.22.1"`).

```
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
npx expo prebuild --platform android
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cd android && ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a
adb install -r app/build/outputs/apk/debug/app-debug.apk
npx expo start --dev-client
```

`android/` is generated and git-ignored.

## UI kit

Decision: **NativeWind v4** (Tailwind classes on React Native), styled in the manner of NativeWindUI.
Screens never import the kit directly; they use wrappers in `src/ui/` (currently `ListRow`), so the kit
can be swapped for React Native Paper without touching screens. Wrappers: `Screen`, `Button`, `TextField`,
`Banner`, `StepHeader`, `Chip`, `ChoiceRow`, `Card`, `EmptyState`, `Money`, `ListRow`, plus `formatInr`. Colours are tokens
in `tailwind.config.js` (paper, surface, ink, muted, line, accent; `-dark` twins used with `dark:`).

Status: NativeWind v4.2 + Tailwind 3.4 builds cleanly on Expo SDK 58 (RN 0.88); the dev client was installed on
the pilot phone and `ListRow` rendered with Tailwind classes. No fallback to React Native Paper was needed.
`ListRow` is a hand-written NativeWind component in NativeWindUI's style; the NativeWindUI package itself
(extra icon/font deps) was not pulled in. Add components to `src/ui/` as needed.

## Releasing

- `docs/release.md`: EAS profiles, cutting a pilot build, template-only vs code updates, rollback.
- `docs/play-sms-declaration.md`: text for the Google Play SMS permission declaration and data safety form.
- `docs/pilot-checklist.md`: the spec section 17 success criteria, how to measure them, and the on-device checks still owed. Read-only helpers: `npx tsx scripts/pilot-parse-rate.ts`, `npx tsx scripts/pilot-duplicates.ts` (stage only).
