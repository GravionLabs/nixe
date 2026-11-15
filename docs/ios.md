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
- Real iPhone: enable Developer Mode (Settings > Privacy & Security), connect via USB and trust the Mac. Export your team id as the `APPLE_DEVELOPMENT_TEAM` environment variable (never write it into a file of the repository; the committed Xcode project and `project.yml` have no team, and `pnpm tauri ios init` with the variable set does not write it into any tracked file), then `pnpm tauri ios dev --host` and pick the device. Xcode must be signed in to the Apple ID (Xcode > Settings > Accounts, personal team).
- A device reaches the dev server over the LAN only with `NSLocalNetworkUsageDescription` in `Info.plist` (set in `project.yml` and `nixe_iOS/Info.plist`); without it iOS blocks the connection and the app shows a network error. Only dev builds need it.
- The device must stay unlocked during the build; the device is a positional argument: `pnpm tauri ios dev "<device name>" --host`.
- `--host` makes Tauri set `TAURI_DEV_HOST` to the Mac's LAN IP; `pnpm run start:tauri` binds `ng serve` to it, so the phone must be on the same network.

## Which parts exist in which build

- The dev panels "Git spike" and "Editor spike (CodeMirror)" are loaded with `@defer` and only when `isDevMode()` is true. A production frontend build (`pnpm build`, also inside `tauri build` and `tauri ios build`) contains their code as a lazy chunk that is never requested, and the initial bundle does not include CodeMirror. The panels therefore show only with `pnpm tauri dev` and `pnpm tauri ios dev`.
- The Rust spike commands (`spike_external_*`, `git_spike_edit`, `git_clone`, `git_commit`, `git_pull_rebase`, `git_push`, `git_token_set`, `git_token_get`, `notes_*`) and their modules `gitsync` and `notes` exist only under `cfg(any(debug_assertions, mobile))`: debug builds on every platform and all iOS builds (including release). A desktop release build registers only the viewer commands. Check with `cargo check --release --manifest-path src-tauri/Cargo.toml`.

## Desktop-only code

Behind `#[cfg(desktop)]` in `src-tauri/src/lib.rs`: `tauri-plugin-single-instance`, native menu (`menu.rs`), stdin capture. `cli_install` stays `macos` only. The frontend menu/drag-drop listeners are desktop integrations. On iOS they threw and blocked the bundled document from opening, so `initDesktopIntegration` in `app.component.ts` wraps them in a try/catch and opens the pending file regardless (verified on a device).

## Checks

- `cd src-tauri && cargo test` and `pnpm test` (desktop)
- `cargo check --target aarch64-apple-ios-sim` (iOS compiles)

## Measurements

- Debug simulator build (warm Rust cache, frontend build included): about 53 s; cold Rust build about 3 min.
- `Nixe.app` debug, simulator: 96 MB.

## Editor spike (#59)

The vault folders of the two spikes differ: the editor spike uses `<Documents>/vault` (`notes.rs`), the Git spike clones into `<app_data_dir>/vault` (`gitsync.rs`). Cloning a repository and then editing the clone in the Files app was not tested.

Dev-only "Editor spike (#59)" panel (`src/app/features/editor-spike/`): opens notes from `<Documents>/vault` (seeded with `sample.md` and a generated 2000-line note) in CodeMirror 6, saves through the Rust commands `notes_list`/`notes_read`/`notes_write` (`src-tauri/src/notes.rs`, the webview only names a file inside that folder), and has a checklist (ok / annoying / blocker) that copies as markdown. `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` make the folder visible in the Files app. A `tauri ios build` bundles the production frontend, so the panel only shows with `pnpm tauri ios dev`.

### Results on the device (iPhone, iOS dev build)

- **CodeMirror 6 works** in the iOS WebView: typing, markdown highlighting, hidden `**` outside the cursor line, checkbox widget, visible caret (the spike's red caret is only a debugging aid, the real editor must not use it) and a font size setting. The checklist is all ok.
- **Files app:** the folder `vault` is visible under "On My iPhone > Nixe". A note in it opens in the app through the Rust commands (`choose a note`).
- **Outside the sandbox (iCloud Drive, other folders):** the Tauri dialog plugin returns a `file://` URL (percent-encoded) from `open({ fileAccessMode: "scoped" })`, files only, no folders. Reading that path from Rust fails with `Operation not permitted (os error 1)`: iOS grants access only after `startAccessingSecurityScopedResource` on the URL, which neither the plugin nor our Rust code calls. A file picked from the app's own folder through the same dialog fails with `No such file or directory (os error 2)`. Not tested: a Swift plugin that holds the security-scoped access (or a bookmark) open. Consequence for the ADR (#61): a vault outside the app folder (iCloud Drive, a folder picker) needs native Swift code; a vault inside `<Documents>` works with Rust alone.
