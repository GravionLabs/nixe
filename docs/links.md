# Links

Links turns the vault into a bookmark library: every saved web page is one Markdown note with
`type: link`. The decisions are in [ADR 0010](adr/0010-links-a-bookmark-library-in-the-vault.md).
This page is the convention that the CLI, the capture window, the browser extension, the MCP tool
and the importers all follow.

## The link note

```markdown
---
type: link
url: https://example.com/articles/vault-first
title: Example Article
tags:
  - reading
saved: 2026-11-20T09:30:00+01:00
status: unread
description: A short article about keeping notes as plain files.
image: https://example.com/images/vault-first.png
site: example.com
---

> A short article about keeping notes as plain files.

## Notes

## Archive

# Keeping notes as plain files

The reader text of the page as Markdown.
```

### Frontmatter

| Key | Required | Value |
|---|---|---|
| `type` | yes | always `link` |
| `url` | yes | the address of the page, `http` or `https` |
| `title` | yes | the title of the page |
| `tags` | yes | a list; empty when the page has none |
| `saved` | yes | when the link was saved, ISO 8601 with offset (`2026-11-20T09:30:00+01:00` or `…Z`) |
| `status` | yes | `unread` or `read`; a new link is `unread` |
| `description` | no | the description of the page (meta description) |
| `image` | no | the URL of the preview image |
| `site` | no | the name or host of the site |

An optional key that is empty is left out, not written empty.

### Body

1. **Description quote:** the description as a block quote, when there is one.
2. `## Notes`: the user's own notes; always present, may be empty. A tool never overwrites it.
3. `## Archive`: the reader text of the page as Markdown. Present on every link note; empty when
   the page was not archived.

The order is fixed so that tools can find the sections by heading.

### File name

The file name is the title plus `.md`. The title is sanitized like `cli_write::note_file_name`
(`src-tauri/src/cli_write.rs`): surrounding whitespace is trimmed, a trailing `.md` is not doubled,
and the characters `\ / : * ? " < > | # ^ [ ]` and control characters are not allowed in a file name
(the tool replaces them; a title that is empty afterwards falls back to the host of the URL). When
a note of that name exists in the folder, ` 2`, ` 3`, … is appended to the name before `.md`
(`Example Article 2.md`). The frontmatter `title` keeps the original title.

## Folders

- **Role `links`:** `.nixe/config.json` → `folders.links`; without an entry the folder is `Links/`
  (see [ADR 0007](adr/0007-vault-configuration-in-nixe.md)). Tools resolve it through the role.
- **Collections:** a subfolder of the links folder is a collection (`Links/Recipes/`). A link note
  may sit in any subfolder; the collection is the folder, not a property.
- **`Links/.archive/`:** optional HTML, screenshot and PDF copies of a page, next to the reader
  text. The folder is gitignored and not synced by Git (the entry joins the `.gitignore` block of
  [vault-git.md](vault-git.md) with the PBI that writes the archive); use a
  file sync service for it if the files are wanted on other devices. A link note refers to such a
  file by name only when it exists on this device.

## Example notes

`fixtures/vault/Links/` has two link notes that the Rust and TypeScript tests use: `Example
Article.md` (read, with an archive) and `Unread Page.md` (unread, no archive).
