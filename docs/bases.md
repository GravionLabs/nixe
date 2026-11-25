# Bases

A `.base` file shows the notes of the vault as a table. The format is the one of
[Obsidian Bases](https://obsidian.md/help/bases/syntax); Nixe supports a first part of it and never
writes a `.base` file.

## Opening a base

The file tree lists `.base` files, also in folders that contain nothing else that is listed. A click
(in the tree or on a bookmark) opens the base in a tab of its own; a second click focuses that tab. The tab is not restored with the
layout. [Vault health](cli.md) does not count a base as an unused attachment.

## What is shown

The tab shows the first view of type `table`, one row per indexed note that matches the
[filters](#filters), sorted by path. The columns are the entries of the view's `order`:

| Entry | Column |
| --- | --- |
| `file.name` | The name of the note without its extension; a click opens the note |
| every other [`file.` field](#file-fields) | The value of the field; dates in local time as `YYYY-MM-DD hh:mm:ss`, lists separated by commas, `file.properties` as `key: value` items |
| `status`, `note.status`, `note["status"]` | The note property `status` (the name ignores case) |

Without `order` the only column is `file.name`; the same column is shown when no entry of `order` is
supported. `properties.<id>.displayName` sets the header of a column. A checkbox property shows as a
checkbox, a list as its items separated by commas, a missing property as an empty cell.

```yaml
properties:
  status:
    displayName: State
views:
  - type: table
    order:
      - file.name
      - status
```

The table follows changes in the vault, those of the `.base` file included.

## Filters

`filters` of the base and `filters` of the shown view both have to match. Each is an expression, or
a mapping with one of these keys over a list of expressions and further such mappings:

| Key | Matches when |
| --- | --- |
| `and` | every entry matches |
| `or` | at least one entry matches |
| `not` | no entry matches |

Empty filters and a group without entries set no condition.

```yaml
filters:
  or:
    - file.hasTag("book")
    - and:
        - file.inFolder("reading")
        - not:
            - status == "done"
views:
  - type: table
    filters: rating >= 4 && !archived
```

An entry is a text. Quote an expression that YAML would read as something else: one that starts with
`!`, `[`, `{` or a quote, contains `: ` or ` #`, or is just `true` or `false` inside a group.

### Expressions

- Literals: text in `"…"` or `'…'` (`\` escapes the next character, `\n` and `\t` are a line break
  and a tab), numbers (`3`, `1.5`), `true`, `false`, lists (`[1, "a"]`).
- Note properties: `status`, `note.status`, `note["my status"]`; the name ignores case. A name with
  spaces or `-` needs the bracket form.
- Operators, tightest first: `!` and unary `-`; `*` `/` `%`; `+` `-`; `<` `<=` `>` `>=`;
  `==` `!=`; `&&`; `||`. Parentheses group.

### File fields

| Field | Value |
| --- | --- |
| `file.name` | The file name with its extension (`Dune.md`); the column of the same name leaves it out |
| `file.basename` | The file name without its extension |
| `file.path` | The path from the vault root |
| `file.folder` | The path of the folder; empty for a note in the root |
| `file.ext` | The extension without the dot (`md`) |
| `file.size` | The size in bytes |
| `file.ctime`, `file.mtime` | When the file was created and last changed. Where the file system records no creation time, `ctime` is the change time; a save that replaces the file can renew it |
| `file.tags` | The tags of the text and the frontmatter, without `#` |
| `file.links` | The targets of the wikilinks and Markdown links: the path of the file, else the target as written |
| `file.embeds` | The same for embeds (`![[…]]`) |
| `file.backlinks` | The paths of the other notes that link to or embed this one |
| `file.properties` | The frontmatter properties |

Links inside frontmatter values are not indexed and count in none of these.

### File functions

| Function | True when |
| --- | --- |
| `file.hasTag("a", "b")` | the note has one of the tags or a tag nested below one (`a/x`); case and a leading `#` do not matter |
| `file.inFolder("folder")` | the note is in the folder or below it |
| `file.hasLink("Note")` | the note links to or embeds that file; a name, a path or `[[…]]`, resolved like a link. A target that is no file matches links written the same way |
| `file.hasProperty("name")` | the frontmatter has the property; the name ignores case |

### Values

- A missing property has no value. It equals only another missing one, is in no order (`<`, `>`, …
  are false) and counts as false.
- False are: no value, `false`, `0`, an empty text, list or mapping. Everything else is true.
- `==` needs the same type: `"5"` is not `5`, texts compare with case, lists item by item.
- Order exists between numbers, between texts (so ISO dates in properties sort as dates) and
  between `file.ctime` or `file.mtime` and a text `YYYY-MM-DD`, optionally with a time
  (`file.mtime > "2026-01-01"`). Without a zone the time is local.
- `+` adds numbers and joins texts (also a text and a number); `-` `*` `/` `%` take numbers only.
  Anything else, a division by zero included, has no value.

## Not supported yet

These parts are read but not applied; the tab names the ones the file uses, so the table is never
silently sorted or cut wrongly:

- `formulas`, `summaries` (both)
- `sort`, `groupBy` and `limit` of the view
- columns of unknown `file.` fields and of `formula.` properties

In filters, `formula.` properties, `this`, other functions (`date()`, `.contains()`, …), fields of
values and date arithmetic are not supported: they are [errors](#errors).

Other keys are ignored. Switching views, other view types, editing and the CLI and MCP are not
supported.

## Errors

The tab shows a message instead of the table for invalid YAML, a file whose keys have the wrong
shape, a file without a view, a file without a `table` view, a base outside the open vault (in a
further folder of the workspace) and when the vault index is not available. A failed read or query is
written to the log.

A syntax error, an unknown function or field and a wrong group in the filters of the base or of the
shown view are errors too: the message names the expression, for example
``Invalid filters: unknown function `file.hasTags` in `file.hasTags("book")`.`` No row is ever
hidden by a filter that could not be read.

## How it works

The frontend reads the file and passes its text to the command `base_query`
([Tauri commands](backend/tauri-commands.md)). The Rust core (`src-tauri/src/bases/`) parses the YAML
and answers the view from the [vault index](architecture.md); the frontend only renders the result.
Only the answer of the newest query is shown.
