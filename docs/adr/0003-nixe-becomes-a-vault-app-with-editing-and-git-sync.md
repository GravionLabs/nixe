# ADR 0003: Nixe becomes an Obsidian-compatible vault app with editing and Git sync

- Status: Accepted
- Date: 2026-11-06
- Supersedes: [ADR 0002](0002-nixe-stays-a-lean-markdown-viewer-no-obsidian-rewrite.md)
- Issues: #44

## Context

ADR 0002 (2026-11-01) kept Nixe a lean, read-only Markdown viewer and left editing, sync and
history to Obsidian, obsidian-git, Git and GitHub. It rejected an Obsidian rewrite because of
the effort (about 15 PBIs to reach parity) and the unproven Tauri iOS and `git2` risk.

The owner now wants to build the editing and sync app in Nixe after all.

Motivation: Nixe is a hobby project for learning. The effort and the iOS risk that ADR 0002
weighed against the rewrite are the point of the project, not a cost to avoid: building the
index, the editor, Git sync and the iOS app is what the owner wants to learn.

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
   (`git2`, HTTPS + token) live in the Rust core. The frontends stay thin. The metadata for the
   index (links, embeds, tags, headings, frontmatter) is extracted in Rust too, so a SwiftUI
   frontend could use the core without the WebView. The TypeScript Markdown core keeps its own
   grammar for rendering; both parsers are tested against the same fixture vault under
   `fixtures/vault/` so they cannot drift apart unnoticed.
3. **Tauri 2 on desktop and iOS** with one Angular frontend and a CodeMirror 6 editor. Native
   Swift appears only as small Tauri plugins.
4. **Spike first.** Milestone M0 is a prototype on a real iPhone: open a vault, edit a note,
   sync with GitHub. Its result is a go / no-go for the rest.
5. **MVP:** file tree, editor, `[[wikilinks]]` with backlinks, search, Git sync (clone, pull
   with rebase, auto-commit, push; on a conflict keep both versions and mark the file). Graph
   view, plugin system and canvas are not part of the MVP.
6. **Editor in stages.** Stage 1 is source mode with styled Markdown (nothing hidden, no
   widgets). Live preview follows after the MVP as CodeMirror decorations: first hiding syntax
   outside the cursor line, then widgets. The spike tests one hiding decoration on iOS.
7. **Conflicts as copies.** On a sync conflict the remote version stays in `Note.md` and the
   local version is written next to it as a conflict copy. The sync never blocks; the user
   resolves with "keep this one" or "keep the other". A merge view can follow on the same basis.
8. **After the MVP:** daily-use features (templates, daily notes, attachments, editable
   properties), the iOS MVP, live preview, Bases, and a plugin system shaped like Obsidian's
   with partial compatibility for selected Obsidian plugins. The index stores all frontmatter
   properties with their type and actions go through a command registry from the start, so
   these build on the MVP instead of reworking it.

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
