# ADR 0003: Nixe becomes an Obsidian-compatible vault app with editing and Git sync

- Status: Proposed
- Date: 2026-11-06
- Supersedes: [ADR 0002](0002-nixe-stays-a-lean-markdown-viewer-no-obsidian-rewrite.md)
- Issues: #44

## Context

ADR 0002 (2026-11-01) kept Nixe a lean, read-only Markdown viewer and left editing, sync and
history to Obsidian, obsidian-git, Git and GitHub. It rejected an Obsidian rewrite because of
the effort (about 15 PBIs to reach parity) and the unproven Tauri iOS and `git2` risk.

The owner now wants to build the editing and sync app in Nixe after all.

Open point for the author: the motivation for reversing ADR 0002 (for example independence from
Obsidian, or a sync flow of its own) is not written down yet. Add it here before accepting.

Technical findings from the planning discussion:

- Rust code runs on iOS directly through Tauri Mobile. As long as the UI stays in the WebView,
  no FFI layer is needed. Native Swift is only needed for platform features (Keychain, share
  sheet, file access outside the sandbox), through Tauri plugins.
- The editor is the most expensive part. With Tauri, the same CodeMirror 6 editor serves
  desktop and iOS. A native live-preview editor in SwiftUI would be a second UI codebase.
- iOS has no Git CLI. `git2` (libgit2) is expected to build for `aarch64-apple-ios` and
  `aarch64-apple-ios-sim`; this is not proven yet.

## Decision

Nixe grows into an Obsidian-compatible vault app with editing and Git sync.

1. **Same format as Obsidian.** Notes are plain `.md` files. `.obsidian/` stays untouched, so
   both apps can work on one vault. Nixe writes only the notes the user edits and the Git
   metadata; its index and caches live in the app data directory, not in the vault.
2. **One Rust core.** Vault scan, wikilink and backlink index, full-text search and Git sync
   (`git2`, HTTPS + token) live in the Rust core. The frontends stay thin.
3. **Tauri 2 on desktop and iOS** with one Angular frontend and a CodeMirror 6 editor. Native
   Swift appears only as small Tauri plugins.
4. **Spike first.** Milestone M0 is a prototype on a real iPhone: open a vault, edit a note,
   sync with GitHub. Its result is a go / no-go for the rest.
5. **MVP:** file tree, editor, `[[wikilinks]]` with backlinks, search, Git sync (clone, pull
   with rebase, auto-commit, push; on a conflict keep both versions and mark the file). Graph
   view, plugin system and canvas are not part of the MVP.

The read-only vault rendering of #9 and #11 stays: the same Markdown core renders the notes.

## Consequences

- Easier: one UI codebase for desktop and iOS, and the logic exists once in Rust.
- Easier: because the logic lives in the Rust core, a SwiftUI frontend through UniFFI remains a
  fallback if the Tauri iOS editor does not hold up.
- Harder: Nixe is no longer only a lean viewer. Startup stays fast only if the editor and the
  index load lazily.
- Harder: the iOS risks stay open until M0 is done: keyboard, scrolling and selection of
  CodeMirror 6 in the WebView, `git2` cross-compilation, no background sync (sync runs on open
  and close), merge conflicts in Markdown, and the younger Tauri Mobile.
- Follow-ups when accepted: update `docs/roadmap.md` (scope and "Out of scope"), the README and
  the constraints of #9, and create the Features as sub-issues of #44.

## Alternatives

- **Keep ADR 0002** (viewer plus Obsidian, obsidian-git and GitHub). Still valid if the spike
  fails or the motivation above does not hold.
- **SwiftUI iOS app with UniFFI from the start.** Native feel and no WebView keyboard issues,
  but a second UI codebase and a large native live-preview editor. Kept as the fallback.
- **Tauri iOS app plus native Swift plugins for single features only.** This is part of the
  decision, not an alternative to it.
