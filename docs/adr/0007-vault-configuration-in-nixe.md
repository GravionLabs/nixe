# ADR 0007: Vault configuration in `.nixe`

- Status: Proposed
- Date: 2026-11-23
- Supplements: [ADR 0003](0003-nixe-becomes-a-vault-app-with-editing-and-git-sync.md)
- Supersedes in part: the rule "Nixe never writes into a vault: no `.nixe/` directory" of [ADR 0002](0002-nixe-stays-a-lean-markdown-viewer-no-obsidian-rewrite.md)
- Issues: #438 (Feature #435, Feature #436)

## Context

Nixe reads the layout of a vault from `.obsidian/` (new-note folder, templates, daily notes). That
file set belongs to Obsidian, does not know the folder roles that agents and skills need (where an
inbox note goes, where a template lives), and cannot carry a language. Until now the docs said
"Nixe never writes into a vault". A vault that is shared by the user, Nixe and coding agents needs
one place, owned by Nixe, that says how the vault is laid out.

## Decision

### Files

| Path | Content | Committed |
|---|---|---|
| `.nixe/config.json` | the vault layout: `language`, `folders`, `files`, `newNotes`, `templates`, `daily`, and `schemaVersion` | yes |
| `.nixe/bookmarks.json` | the bookmarks of the vault | yes |
| `.nixe/local/` | state of one machine; never committed | no |

`schemaVersion` is an integer. Nixe refuses to write a file with a newer `schemaVersion` than it
knows and migrates an older one on the next write. Unknown keys are kept.

What stays in the app data directory, not in the vault: the folds of notes, the window state, the
settings of the app, the index and the caches. They belong to the machine or the user, not to the
vault.

### Fallback to `.obsidian/`

`.obsidian/` is read only, for the keys `.nixe/config.json` does not set, until release **1.16.0**
(the expiry). From that release on `.obsidian/` is no longer read. Nixe never writes `.obsidian/`.

### Automatic import at start

When a vault is opened and `.nixe/config.json` does not exist, Nixe imports once what `.obsidian/`
holds and maps to a key: the new-note folder and link format (`app.json`), the template folder
(`templates.json`), the daily note folder, format and template (`daily-notes.json`) and the
bookmarks (`bookmarks.json`). It writes `.nixe/config.json` and `.nixe/bookmarks.json`; a file that
exists is never replaced, so the import does not run twice. The import writes into the vault, so
the new files appear in the next Git commit. Nixe says so when it imports.

### Folder roles and file roles

Folder roles: `inbox`, `journal`, `templates`, `attachments`, `projects`, `areas`, `resources`,
`archive`, `clippings`, `subjects`, `sources`, `exams`. File roles: `profile`.

- A role that is missing in `folders` (or `files`) resolves to its English default name (`Inbox`,
  `Templates`, `Exams`, …).
- The names on disk are what Nixe shows. There is no display translation, so wikilinks, search,
  Git and other tools all see the same name.
- Skills and Nixe resolve folders only through the roles, never through a hard-coded name.

### Own roles

`folders` takes any key besides the standard roles. An entry is a path (`"exams": "Prüfungen"`) or an
object `{ "path": "Prüfungen", "description": "…" }`. The description says what belongs into the
folder, so a skill can file into an own role (`vault-inbox`) and a vault's own skill can address it
by name.

- A folder without a role is no target for an agent, except when the user asks for it.
- The core rule for `CLAUDE.md`: "read the folder roles in `.nixe/config.json`, file notes only into
  a folder with a role".
- A role whose folder is missing is kept and reported, never removed silently.

### Languages

`language` (BCP 47, default `en`) is the language of the notes the agents write. `lang` in the
frontmatter of a note wins. Frontmatter keys (`type`, `subject`, `date`, …) stay English; their
values are free. Note titles are never translated. The UI language of Nixe is separate (M008).

### What a vault commits

The full list and the `.gitignore` block are in [vault-git.md](../vault-git.md).

| Path | Committed | Why |
|---|---|---|
| notes, attachments | yes | the content |
| `.nixe/config.json`, `.nixe/bookmarks.json` | yes | the layout is the same on every machine |
| `.nixe/local/` | no | state of one machine |
| `.obsidian/` | the user's choice | Nixe only reads it (until the expiry) |
| `.<name>.nixe-tmp` | no | temp file of an atomic save |
| conflict copies | yes | they are notes the user must resolve |
| index, caches, folds, window, app settings | no | not in the vault at all (app data) |

Because the Git sync commits the whole vault, the vault's `.gitignore` must list `.nixe/local/` and
`.*.nixe-tmp`. Nixe warns when an entry is missing (Feature #436).

## Alternatives

- **Keep reading `.obsidian/` only:** no roles, no language, and Obsidian can rewrite the file.
- **Keep the config in the app data directory:** the layout would differ per machine, and agents
  and skills in the vault could not read it.
- **Translate folder names for display:** wikilinks, search, Git and other tools would disagree
  with what the user sees.
- **Keep the fallback forever:** two sources of truth that drift apart.

## Consequences

- Nixe writes into the vault (`.nixe/`) and the first start imports into the next Git commit.
- The sentence "Nixe never writes into a vault" no longer holds; the docs say "Nixe never writes
  `.obsidian/`" instead.
- Skills, agents and Nixe share one source for folder names and the note language.
- A user of Obsidian keeps working: the fallback covers the time until the expiry.
- Following issues implement the reader, the writer, the import and the `.gitignore` warning.
