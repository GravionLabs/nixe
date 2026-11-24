# ADR 0010: Links: a bookmark library in the vault

- Status: Proposed
- Date: 2026-11-24
- Issues: #499 (PBI #500)

## Context

Nixe is to save web pages like Linkwarden does, but inside the vault: no server, no database of its
own. Sync, search, tags and views already exist (Git sync, the vault index, Bases). Several later
PBIs (the CLI, the capture window, a browser extension, the MCP server, importers) write or read the
same notes, so the format and the folders must be written down once.

## Decision

### Name

The feature is called **Links**. A saved page is a *link note* and carries `type: link`. The CLI
command is `nixe clip <url>`. It does not clash with the bookmarks of Obsidian (#440,
`.nixe/bookmarks.json`), which point at notes, headings and searches inside the vault.

### Note format

One Markdown note per link. The metadata is frontmatter (`type`, `url`, `title`, `tags`, `saved`,
`status`, optional `description`, `image`, `site`), the reader text is the body. The format is a
vault convention, documented in [links.md](links.md), not a new file type: any editor and the vault
index read it as a note.

### Archive

The default archive is the **reader text** (Readability, converted to Markdown). It lives in the
same note under `## Archive`, so search, Git history and sync cover it without extra machinery.
A single-file HTML, a screenshot or a PDF are optional per vault and go to `Links/.archive/`. That
folder is gitignored and not synced by Git: such files are large binaries (see
[ADR 0009](0009-epub-reader-foliate-js-sandbox-and-storage.md) for the same reasoning).

### Folder role

The folder role `links` in `.nixe/config.json` (`folders.links`, see
[ADR 0007](0007-vault-configuration-in-nixe.md)) names the folder; the default is `Links/`.
Subfolders are collections. Code resolves the folder only through the role.

### Browser extension: Native Messaging

The extension talks to Nixe through Native Messaging; the host is the nixe binary
(`nixe native-host`). The extension lives in this repository as `extension/` in the pnpm workspace,
one MV3 codebase for Chromium (Chrome, Edge, Brave) and Firefox. It sends the rendered HTML, so
pages behind a login can be saved.

### MCP: write tool only on request

`nixe mcp` **stays read-only by default**. A write tool `clip_link` exists, but only with the flag
`--allow-clip`. It creates new notes in the links folder and never changes an existing note.

### Maintenance in stage 1

URL dedupe on save, a dead-link check (`nixe check --links`, Wayback Machine as fallback), and
imports from a browser bookmarks HTML, Pocket, Raindrop and Linkwarden.

### Milestones

Stage 1 is milestone **M005.8 Links**. Stage 2 (a links view and an unread inbox, built on Bases)
follows after M006 Bases. The iOS share sheet comes with M009. The web tab (#461) is related, not a
blocker.

## Consequences

- Links are ordinary notes: they sync, are searched and tagged, and can be edited by hand.
- The reader text makes a note large; a vault with many links grows faster than one without.
- A format change later needs a migration of the notes, so the format is fixed here first.
- The extension adds a second artefact (the extension) and a host manifest to install per browser.
