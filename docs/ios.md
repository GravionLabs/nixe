# iOS toolchain

Spike (#58): Nixe on an iPhone. The viewer shows the bundled `fixtures/ios.md` (Mermaid and KaTeX) on start; opening other files is not supported on iOS yet.

## Setup

1. Install Xcode from the App Store, then `sudo xcode-select -s /Applications/Xcode.app` and `sudo xcodebuild -license accept`.
2. Install the iOS Simulator runtime (about 8 GB, do not wrap in `timeout`): `xcodebuild -downloadPlatform iOS` (Xcode > Settings > Components). Without it `tauri ios build` fails with "Xcode Simulator SDK ... is not installed".
3. Rust targets: `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`
4. Tools: `brew install cocoapods xcodegen`
5. `pnpm install`
6. `pnpm tauri ios init` (generates `src-tauri/gen/apple`, committed).

## Run

- Simulator (verified, iOS 27.2 runtime): `pnpm tauri ios dev` archives with signing and fails on a Mac without a development team ("Signing ... requires a development team"). Without a team use: `pnpm run start:tauri` in one terminal, then `pnpm tauri ios build --debug --target aarch64-sim --ci`, `xcrun simctl boot <udid>`, `xcrun simctl install booted src-tauri/gen/apple/build/arm64-sim/Nixe.app`, `xcrun simctl launch booted dev.nixe.app`.
- Real iPhone: enable Developer Mode (Settings > Privacy & Security), connect via USB and trust the Mac. Put your team id in `src-tauri/tauri.conf.json` under `bundle.iOS.developmentTeam` (or `APPLE_DEVELOPMENT_TEAM` env var), then `pnpm tauri ios dev --host` and pick the device. Xcode must be signed in to the Apple ID (Xcode > Settings > Accounts, personal team).
- A device reaches the dev server over the LAN only with `NSLocalNetworkUsageDescription` in `Info.plist` (set in `project.yml` and `nixe_iOS/Info.plist`); without it iOS blocks the connection and the app shows a network error. Only dev builds need it.
- The device must stay unlocked during the build; the device is a positional argument: `pnpm tauri ios dev "<device name>" --host`.
- `--host` makes Tauri set `TAURI_DEV_HOST` to the Mac's LAN IP; `pnpm run start:tauri` binds `ng serve` to it, so the phone must be on the same network.

## Desktop-only code

Behind `#[cfg(desktop)]` in `src-tauri/src/lib.rs`: `tauri-plugin-single-instance`, native menu (`menu.rs`), stdin capture. `cli_install` stays `macos` only. The frontend menu/drag-drop listeners are desktop integrations. On iOS they threw and blocked the bundled document from opening, so `initDesktopIntegration` in `app.component.ts` wraps them in a try/catch and opens the pending file regardless (verified on a device).

## Checks

- `cd src-tauri && cargo test` and `pnpm test` (desktop)
- `cargo check --target aarch64-apple-ios-sim` (iOS compiles)

## Measurements

- Debug simulator build (warm Rust cache, frontend build included): about 53 s; cold Rust build about 3 min.
- `Nixe.app` debug, simulator: 96 MB.

## Editor spike (#59)

Dev-only "Editor spike (#59)" panel (`src/app/features/editor-spike/`): opens notes from `<Documents>/vault` (seeded with `sample.md` and a generated 2000-line note) in CodeMirror 6, saves through the Rust commands `notes_list`/`notes_read`/`notes_write` (`src-tauri/src/notes.rs`, the webview only names a file inside that folder), and has a checklist (ok / annoying / blocker) that copies as markdown. `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` make the folder visible in the Files app. A `tauri ios build` bundles the production frontend, so the panel only shows with `pnpm tauri ios dev`.
