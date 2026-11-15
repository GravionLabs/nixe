# ADR 0004: Tauri on iOS: go, git2 for Git sync, native Swift only for file access outside the sandbox

- Status: Accepted
- Date: 2026-11-15
- Issues: #61
- Builds on: [ADR 0003](0003-nixe-becomes-a-vault-app-with-editing-and-git-sync.md)

## Context

ADR 0003 made the iOS spike (M000) the gate for Git sync and the iOS app: open a vault, edit a
note in CodeMirror 6 and sync with GitHub, all on a real iPhone. Three PBIs ran the spike on an
iPhone with a development build (`pnpm tauri ios dev`). The toolchain and editor details are in
[docs/ios.md](../ios.md); the Git numbers come from the device runs of #60 (PR 125) and are not
recorded elsewhere in the repository.

- **Toolchain (#58):** the Tauri 2 viewer runs on the simulator and on the iPhone, including
  Mermaid and KaTeX. A debug simulator build takes about 53 s with a warm Rust cache and about
  3 min cold; `Nixe.app` is 96 MB in debug. The frontend listeners for the menu and drag and drop
  throw on iOS and are guarded; the desktop-only Rust plugins sit behind `cfg(desktop)`. A device reaches the dev server only with
  `NSLocalNetworkUsageDescription`.
- **Git (#60):** `git2` 0.21 builds for `aarch64-apple-ios` and the simulator with the features
  `https`, `vendored-libgit2` and `vendored-openssl`; without `https` the clone fails with "no
  TLS stream available". On the iPhone, with a private repository of 1000 notes: clone 1.7 to
  1.9 s, commit 73 ms, pull --rebase 631 ms, push 1.5 s. The access token lives in the iOS
  Keychain through the `keyring` crate (`apple-native`), set and read from Rust, never on disk.
- **Editor (#59):** CodeMirror 6 works in the iOS WebView: typing, Markdown highlighting,
  hiding `**` outside the cursor line, a checkbox widget, a visible caret and a configurable
  font size. All 11 checklist items were rated ok. The editor spike's folder `<Documents>/vault` is
  visible in the Files app (`UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`), and a
  note in it opens in the app. The Git spike cloned into a different folder,
  `<app_data_dir>/vault`; the two folders are not the same, and cloning a repository and then
  editing the clone in the Files app was not tested.
- **Files outside the app folder:** the Tauri dialog plugin returns a percent-encoded `file://`
  URL, offers files only (no folder), and Rust cannot read that URL: `Operation not permitted
  (os error 1)`. iOS grants access only after `startAccessingSecurityScopedResource` on the URL,
  and neither the plugin nor our Rust code calls it. A Swift plugin that does this was not
  built or tested.

Not measured: release builds (all numbers are from debug dev builds), vaults larger than 1000
notes, iPad, sync conflicts on a device, background behavior, and Git over SSH.

## Decision

1. **Go for Tauri 2 on iOS.** The Rust core, the Angular frontend and the CodeMirror 6 editor
   run on the iPhone as ADR 0003 assumed. The spike gate of ADR 0003 is passed. M001, M001.1
   and M003 are not blocked by iOS, and M005 (iOS MVP) can be planned.
2. **Git sync uses `git2` (libgit2) in the Rust core**, over HTTPS with a personal access
   token, with the features `https`, `vendored-libgit2` and `vendored-openssl` (`git2` 0.21 has no default features, so SSH is not compiled in). The same code serves desktop and iOS. The token is kept in the
   Keychain (macOS and iOS) through `keyring`. Windows and Linux have no token store yet; the
   spike returns an error there, and M003 decides which store to use.
3. **The vault lives in the app container on iOS:** `<Documents>/vault`, created by cloning the
   repository (the spike deletes an earlier folder before it clones; the real clone must not). The Rust commands name files relative to that folder, refuse names that leave it
   and refuse symlinks, and write through a temporary file and a rename. Keep
   `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` so the user can see and edit
   the vault in the Files app.
4. **Native Swift is limited to what the WebView and Rust cannot do.** Known today: opening a
   folder or file outside the app container (iCloud Drive, other apps) needs a Tauri plugin
   that calls `startAccessingSecurityScopedResource` and stores a bookmark. It is not part of
   the iOS MVP: the MVP vault is a clone inside the container. Keychain access does not need
   Swift, and neither do Git, the index or the editor. The share sheet was not tested and stays
   open until M005 is planned.
5. **Follow-ups, not decided here:**
   - Sync today aborts a rebase on a conflict. ADR 0003 asks for conflict copies; that is a
     task of M003.
   - The spike code (the Git and editor spike panels, `git_spike_edit` and the
     `spike_external_*` commands, the red caret) is removed once its findings are used. The
     real editor and Git commands are built in the milestones above, not taken over as is.
   - The toolbar of the viewer does not fit an iPhone; a mobile bar is #122.

## Consequences

- Easier: one codebase for desktop and iOS. Git sync is written and tested once in Rust (the
  `git2` tests run on the desktop against local bare repositories).
- Easier: no Swift is needed for the MVP, so there is no second toolchain beyond Xcode and the
  signing of the app.
- Not yet verified: that a clone made by the Git code can be opened and edited through the Files app folder of decision 3.
- Harder: a vault outside the app container (iCloud Drive, a folder of another app) needs a
  Swift plugin and a bookmark flow that is untested. The Files app shows the container, but a
  user who keeps the vault in iCloud Drive cannot use it with the MVP. The MVP user clones from
  GitHub.
- Harder: `git2` brings a vendored libgit2 and OpenSSL into the build. Compile time and the
  size of the app grow; the effect on a release build was not measured.
- Harder: the release builds on the Windows runner currently fail for an unrelated reason (the
  MSI version of a pre-release, #124). It is not caused by this decision.
- A development build needs a signed-in Apple ID, Developer Mode and an unlocked device. The
  team ID stays out of the repository (`APPLE_DEVELOPMENT_TEAM`).
- If a later step on a device fails, ADR 0003 names the fallback: the logic stays in the Rust
  core, so a SwiftUI frontend through UniFFI remains possible.

## Alternatives

- **No-go, SwiftUI frontend through UniFFI or desktop only.** Not chosen: nothing in the spike
  blocked the Tauri route. The editor, Git and the Keychain all worked on the iPhone. It stays
  the fallback of ADR 0003 if M005 finds a blocker.
- **`gix` (gitoxide) instead of `git2`.** Not evaluated in the spike. `git2` already did clone,
  commit, pull --rebase and push on the iPhone, so there was no need to try another library.
- **GitHub REST API instead of a local repository.** Not evaluated. It would avoid libgit2, but
  it works against GitHub only, needs a network for every read, and gives no local history. The
  vault would no longer be a Git repository that Obsidian and the terminal can use.
- **The vault in iCloud Drive or another folder from the start.** Not chosen for the MVP
  because it needs the untested Swift plugin of decision 4.
- **Remove the file sharing keys.** The vault would then be reachable only inside the app. The
  user could no longer open the notes in another editor or check them in the Files app.
