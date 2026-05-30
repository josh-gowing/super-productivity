# Apple (iOS & macOS) release automation

Pushing a final version tag (`vX.Y.Z`) builds, signs, uploads **and submits**
the iOS and macOS App Store builds for review, set to release automatically once
Apple approves them. The only step that is not automated is Apple's human
review.

## Pipeline

| Target | Workflow | Output |
| --- | --- | --- |
| iOS App Store | `.github/workflows/build-ios.yml` | `.ipa` → App Store Connect |
| Mac App Store | `.github/workflows/build-publish-to-mac-store-on-release.yml` | MAS `.pkg` → App Store Connect |
| Mac direct download (notarized DMG/zip, auto-update) | `.github/workflows/build.yml` (`mac-bin`) | GitHub release asset |

On a tag push each workflow builds and signs the artifact, then runs a fastlane
lane (`fastlane/Fastfile`, `ios release` / `mac release`) that:

1. Uploads the artifact to App Store Connect.
2. Pushes the "What's New" release notes (derived from `build/release-notes.md`
   by `tools/prepare-appstore-release-notes.js`). Other listing metadata and
   screenshots are managed by hand in App Store Connect and are **not** touched.
3. Waits for App Store Connect to finish processing the build.
4. Submits the version for review with **automatic release on approval**.

### Submit vs. upload-only

`SUBMIT_FOR_REVIEW` is computed per run:

- **Final tag** (`vX.Y.Z`) → upload **and** submit for review.
- **Pre-release tag** (`v…-RC…` / `beta` / `alpha`) or **manual
  `workflow_dispatch`** → upload only (build lands in App Store Connect /
  TestFlight, no store submission).

## Required secrets

Authentication uses an **App Store Connect API key** (reused from the
notarization secrets), which is more robust in CI than an Apple ID +
app-specific password:

| Secret | Used as | Purpose |
| --- | --- | --- |
| `mac_api_key` | `ASC_KEY_CONTENT` | Contents of the `.p8` key file |
| `mac_api_key_id` | `ASC_KEY_ID` | API key id |
| `mac_api_key_issuer_id` | `ASC_ISSUER_ID` | API issuer id |

> **Important:** the API key must belong to a user with the **App Manager** role
> (or higher). A key with only the **Developer** role can upload/notarize but
> **cannot create a version or submit it for review**. If submission fails with
> a permissions error, mint a new key with the App Manager role and update the
> three secrets above.

## Caveats

- **Apple review is the only manual gate** — it is performed by humans (~1–2
  days) and can be rejected. Everything up to and including submission is
  automated.
- **"What's New" locales:** only `en-US` notes are generated. If the App Store
  listing has additional active locales, Apple may require "What's New" text for
  them on submission. Add more `release_notes.txt` files (or extend
  `tools/prepare-appstore-release-notes.js`) as needed.
- **Export compliance:** if `ios/App/App/Info.plist` does not set
  `ITSAppUsesNonExemptEncryption`, App Store Connect will pause the submission
  to ask the encryption question. Set it once to keep submission fully hands-off.
