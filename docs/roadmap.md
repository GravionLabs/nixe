# Roadmap: Nixe as a vault app

Status: 2026-11-26. Epic: [#44](https://github.com/GravionLabs/nixe/issues/44).
Decisions: [ADR 0003](adr/0003-nixe-becomes-a-vault-app-with-editing-and-git-sync.md) (vault app,
supersedes [ADR 0002](adr/0002-nixe-stays-a-lean-markdown-viewer-no-obsidian-rewrite.md)) and
[ADR 0004](adr/0004-tauri-on-ios-go-git2-for-git-sync-native-swift-only-for-file-access-outside-the-sandbox.md)
(Tauri on iOS: go).

## Goal

Nixe grows from a Markdown viewer into a vault app that edits and syncs, on desktop and iOS. It
works on the same plain `.md` files and folder layout as Obsidian, so both apps can use one vault.

## Principles

- **Same format as Obsidian.** Notes are plain `.md` files and `.obsidian/` is never written; the layout of the vault lives in `.nixe/` ([ADR 0007](adr/0007-vault-configuration-in-nixe.md)).
- **One Rust core, thin frontends.** Vault scan, index, search and Git sync live in `src-tauri/`.
- **Two parsers, one fixture vault.** The TypeScript Markdown core renders; the Rust core
  extracts metadata for the index. Both are tested against `fixtures/vault/`.
- **Lazy loading.** Startup stays fast: the editor and the index load on demand.

## Milestones

A milestone is a release. The open milestone with the lowest number is the current one; a sub-number (`M006.2`) sorts between `M006` and `M007`. This table follows GitHub: it changes when a milestone is created, renumbered or closed.

### Shipped

| Milestone | Version | Content | Features |
|---|---|---|---|
| M000 | 1.0.0 | iOS spike (gate): open a vault, edit, sync on a real iPhone. Result: go (ADR 0004) | #49, #10 |
| M001 | 1.0.0 | Vault viewer: Obsidian rendering and the vault index in the Rust core | #11, #12, #50 |
| M002 | 1.0.5 | Vault editor, first slice | #13 |
| M001.1 | 1.1.0 | Vault editor: CodeMirror 6, source mode with styled Markdown | #51 |
| M001.2 | 1.2.0 | CLI, MCP and vault health | #87, #88 |
| M003 | 1.3.0 | Git sync: clone, pull with rebase, auto-commit, push, conflict copies | #14, #52 |
| M004 | 1.3.0 | Daily use: templates, daily notes, attachments, editable properties, tabs, settings | #15, #53 |
| M003.2 | 1.4.0 | Desktop shell on helix ([ADR 0005](adr/0005-nixe-ui-on-helix.md)) | #197 |
| M003.1 | 1.5.0 | Git history per note, AI changes as review ([ai-review.md](ai-review.md)) | #89, #90 |
| M003.3 | 1.5.0 | Helix shell polish | |
| M004.1 | 1.6.0 | Editor and workspace comforts | #91 |
| M004.2 | 1.7.0 | Workspaces of several folders, quick capture, export | #92, #93, #94, #229 |
| M004.3 | 1.9.0 | Git view and history for users without Git knowledge, terminal and agent panel | #291, #313, #314 |
| M005 | 1.9.0 | Live preview | #55 |
| M005.1 | 1.10.0 | Live preview polish: tables and frontmatter, text size, folded properties, view modes, table editing | #373 |
| M005.2 | 1.10.2 | Browser build with a fake backend, e2e tests and screenshots ([frontend/demo.md](frontend/demo.md)) | #399 |
| M005.3 | 1.11.0 | Fixes and preview tabs | #415, #428 |
| M005.6 | 1.11.1 | Angular 22.3 and fixes | |
| M005.4 | 1.12.0 | Log ([backend/logging.md](backend/logging.md)) | #409 |
| M005.5 | 1.13.0 | Vault conventions: `.nixe/`, what goes into Git ([ADR 0007](adr/0007-vault-configuration-in-nixe.md), [vault-git.md](vault-git.md)) | #435, #436, #437, #462 |
| M005.7 | 1.14.0 | EPUB reader ([ADR 0009](adr/0009-epub-reader-foliate-js-sandbox-and-storage.md), [frontend/epub.md](frontend/epub.md)) | #460 |
| M005.8 | 1.15.0 | Links: a bookmark library in the vault, stage 1 ([ADR 0010](adr/0010-links-a-bookmark-library-in-the-vault.md), [links.md](links.md)) | #479 |
| M005.9 | 1.16.0 | PDF export ([export.md](export.md)) | #598 |
| M006 | 1.17.0 | Bases ([bases.md](bases.md)) | #56 |
| M006.1 | 1.18.0 | Links view | |

M001, M001.1 and M003 together were the desktop MVP: file tree, editor, `[[wikilinks]]` with
backlinks, search and Git sync. M000 gated Git sync and iOS only; the desktop viewer, index and
editor did not wait for it.

### Next, in this order

| Milestone | Content | Features |
|---|---|---|
| M006.2 | EPUB reader polish: theme colors, line width and columns, header and page turning, table of contents; small fixes of the terminal and the file tree | #616, #617, #618, #619 (Epic #614) |
| M006.3 | Links bookmark manager like Linkwarden: navigation column, cards, dashboard, collections, New Link dialog | #677 |
| M006.4 | Bases in the app: create, list and edit bases, every file of the vault as a row | #666 |
| M007 | Maintenance: Node.js 26, a pinned Rust toolchain, the Windows MSI with a pre-release version | |
| M008 | Forms and controls on the helix-ui primitives, before their texts are marked for translation | #665 |
| M009 | German UI through i18n, error codes from the Rust core, the native menu | #315 |
| M010 | iOS MVP: mobile layout, native Swift plugins, sync on open and close; the inbox for photos and scans | #54, #591 |
| M011 | Agent scripts on the open note and on new files ([ADR 0011](adr/0011-agent-scripts-in-nixe.md)) | #295 |
| M012 | Bases editor, further views and the rest of Obsidian's Bases | #640 |
| M013 | Plugin system, shaped like Obsidian's with partial compatibility | #57 |

The Features and their sub-issues are on the Epic. Within a milestone a PBI starts when its
blockers are done; the PBIs of a Feature are created with the planner when its milestone comes up.

## Later or never

- **Without a milestone:** web pages as a tab (#461), sign-in to GitHub without a hand-made token (#352, its device flow #354 is in M010).
- **Later or never:** graph view, canvas, a Claude API client in the app (AI changes come
  through Git branches, #90).

## What Nixe writes

- The notes the user edits, and the Git metadata (`.git/`) of the vault.
- The vault layout in `.nixe/` ([ADR 0007](adr/0007-vault-configuration-in-nixe.md)); never `.obsidian/`. The index and caches live in the app data directory, not in the vault.
  They can be deleted and are rebuilt on open.

## Risks

- **iOS.** CodeMirror 6 keyboard and selection in the WebView, no background sync (sync runs on
  open and close), a younger Tauri Mobile. ADR 0004 records the spike results; the fallback is a
  SwiftUI frontend through UniFFI on the same Rust core.
- **Sync conflicts.** Two devices editing one note. The remote version stays in `Note.md` and the
  local version is written next to it as a conflict copy; the sync never blocks.
- **Two parsers.** The TypeScript and the Rust parser can drift apart. Both are tested against
  `fixtures/vault/`.
- **Scope creep.** Obsidian has many syntax corners (Dataview, canvas, footnote styles). The
  fixture vault defines what is in.
- **Startup time.** The index and the editor load lazily to keep the viewer fast.
