# Command line

`nixe <path>` and `nixe -` open the viewer. The subcommands below read the vault index
instead: they start no window, print to stdout and report errors on stderr. Without `--json`
the output is plain text; with it, a JSON array whose shape is listed below.

The first argument decides: `nixe search` is the subcommand, `nixe ./search` opens a file
named `search`.

| Command | Prints |
|---|---|
| `nixe search <query>` | Notes matching the query, best first (at most 50), with up to 3 matching lines each. Same syntax as the in-app search: words match as prefixes, `"a phrase"`, `tag:#name`, `path:folder/`. |
| `nixe backlinks <note>` | Links that point to the note (a note linking to itself excluded). |
| `nixe links <note>` | Links, embeds and Markdown links inside the note, with their resolved target. |
| `nixe tags` | Every tag with the number of notes using it, most used first. |
| `nixe notes [--tag <tag>]… [--path <prefix>]` | Notes carrying every given tag (nested tags match) below the vault-relative path prefix, sorted by path. |
| `nixe props <note>` | The typed frontmatter properties of the note. |

`<note>` is a vault-relative path (with or without `.md`) or a unique note name, resolved
like a `[[wikilink]]`. A missing or ambiguous note is an error.

## Options

- `--vault <dir>`: the vault. Without it, the vault that contains the current directory (the
  topmost parent holding `.obsidian/`, else the current directory itself).
- `--json`: machine-readable output.

Before answering, the index (the one the app uses, below the app data directory) is brought up
to date with an incremental scan, so the answer reflects the files on disk. On an indexed
2000-note vault a subcommand answers in under 300 ms.

Exit codes: `0` ok, `1` the query failed (unknown note, unreadable vault), `2` wrong arguments.

On Windows a release build is a GUI program and has no console of its own, so the output of a
subcommand only shows when it is redirected or piped.

## JSON shapes

`line` is 1-based. `null` marks a part a link does not have.

### `search`

```json
[
  {
    "path": "Frontmatter.md",
    "title": "Frontmatter",
    "snippets": [{ "line": 17, "text": "Body with #body-tag." }]
  }
]
```

### `backlinks`

```json
[
  {
    "source": "Index.md",
    "heading": "Second heading",
    "block": null,
    "alias": null,
    "kind": "link",
    "line": 4,
    "context": "- [[Note#Second heading]] scrolls to the heading"
  }
]
```

`kind` is `link`, `embed` or `markdown`.

### `links`

```json
[
  {
    "target": "Deep",
    "heading": null,
    "block": null,
    "alias": null,
    "kind": "link",
    "resolved": "folder/Deep.md",
    "line": 7
  }
]
```

`resolved` is `null` when the target is missing or ambiguous.

### `tags`

```json
[{ "tag": "body-tag", "count": 1 }]
```

### `notes`

```json
[{ "path": "folder/Deep.md", "title": "Deep", "aliases": [] }]
```

### `props`

```json
[
  { "key": "number", "type": "number", "value": 42 },
  { "key": "list", "type": "list", "value": ["one", "two"] }
]
```

`type` is the property type of the index (`text`, `number`, `checkbox`, `date` or
`list`); `value` is the typed JSON value.
