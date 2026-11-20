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

## Health check

`nixe check [--exclude <dir>]… [--json]` prints the vault health report, the same one the
`Vault health` view shows (command palette: "Vault health"), and exits with `1` when the
vault has broken links, so it can run in CI or a pre-commit hook.

| Section | Lists |
|---|---|
| Broken links | Links, embeds and Markdown links that resolve to no file (missing or ambiguous), with note, line and the linking line. |
| Orphan notes | Notes with no link to or from another note. Daily notes (`YYYY-MM-DD`) never count. |
| Duplicate basenames | Notes sharing a name (case-insensitive), which makes `[[name]]` ambiguous. |
| Unused attachments | Non-Markdown files that no note links or embeds. Hidden paths (`.something/`) are skipped. |

`--exclude <dir>` (repeatable) leaves a vault-relative folder and everything below it out of
every section, for example `templates` or `archive`. In the app the folders are set in the
excluded-folders field of the view (setting `healthExclude`). The report is computed from the
index with a few queries: under a second for 2000 notes.

With `--json` the report is one object:

```json
{
  "brokenLinks": [{ "source": "Index.md", "line": 8, "target": "Missing", "kind": "link", "context": "- [[Missing]] stays unresolved" }],
  "orphans": [{ "path": "Frontmatter.md", "title": "Frontmatter" }],
  "duplicates": [{ "name": "Twin", "paths": ["folder/Twin.md", "other/Twin.md"] }],
  "unusedAttachments": []
}
```

## Capture

`new` and `append` write to the vault. They print the absolute path of the note and need no
index.

| Command | Does |
|---|---|
| `nixe new <title> [--folder <dir>] [--open]` | Creates an empty note `<title>.md` and never replaces one (exit 1 when it exists). The folder is `--folder` (vault-relative, created if missing), else the new-note folder of `.obsidian/app.json`, else the vault root. `--open` then opens the note in the viewer. |
| `nixe append <note> [text]` | Appends the text (the remaining arguments joined by a space, or stdin when there are none) on its own line(s). A missing note is created: `a/b` is a path in the vault, a bare name goes to `--folder` or the new-note folder. |
| `nixe append --inbox [text]` | Appends to `Inbox.md` in the inbox folder: the new-note folder of the vault when it sets one, else `Inbox/`. |
| `nixe daily [--append <text>]` | The daily note of today: folder, date format and template come from `.obsidian/daily-notes.json` (the app settings do not reach the command line; the defaults are the vault root and `YYYY-MM-DD`). A missing note is created from its template. With `--append` the text goes on its own line at the end and nothing opens; without it the note opens in the viewer. Prints the path. |

Writes replace the note atomically (a temp file renamed into place) and refuse paths outside
the vault, including `..`, absolute paths and symlinks that lead out. A Nixe window that shows
the note picks the change up through its file watcher.

`<note>` is a vault-relative path (with or without `.md`) or a unique note name, resolved
like a `[[wikilink]]`. A missing or ambiguous note is an error.

## Export

`nixe export <note> --format html|pdf [--out <file>] [--dark|--light] [--page-size <size>]` does what
the commands "Export as HTML", "Export as PDF" and "Print" do in the app (see
[export.md](export.md)). The rendering lives in the app, so the command resolves the note like a
`[[wikilink]]`, checks the arguments (exit `2` when wrong, `1` for an unknown note) and then starts
the app for the export.

- `--format html` writes one self-contained file to `--out` (default: `<note name>.html` in the
  current directory) and prints its path. No window shows; the command ends when the file is written.
- `--format pdf` opens the note with the print dialog: the system web views have no silent print,
  so the PDF is saved from that dialog ("Save as PDF"). `--out` is refused.
- `--dark` / `--light` and `--page-size A3|A4|A5|Letter|Legal` override the export settings.
- When Nixe is already running, its window does the export and the command returns at once.

### Export a folder as a site

`nixe export <folder> --site <out> [--exclude <dir>]... [--vault <dir>]` writes a folder as a static
website, see [export.md](export.md#folder-as-a-static-site). It needs no window and no running app,
and prints the number of pages. `--site` cannot be combined with `--format` or `--out`.

## Options

- `--vault <dir>`: the vault. Without it, the vault that contains the current directory (the
  topmost parent holding `.obsidian/`, else the current directory itself).
- `--vault <dir>` more than once, or `--workspace <name>` (a workspace saved in the app, see
  [workspaces.md](workspaces.md)): `search`, `notes` and `tags` then cover all the folders. The
  root of a result is its folder name (`notes`, `notes (2)` for equal names; in a workspace the
  name of the root). Text output prefixes it (`wiki:Page.md`), JSON adds `"root"` (and, for
  `search`, `"rootPath"`). `search` takes `root:<name>` (`root:"two words"`) to keep one root.
  `tags` adds the counts up. The other commands work on one vault and refuse several.
  `--workspace` and `--vault` cannot be combined.
- `--json`: machine-readable output.

Before answering, the index (the one the app uses, below the app data directory) is brought up
to date with an incremental scan, so the answer reflects the files on disk. On an indexed
2000-note vault a subcommand answers in under 300 ms.

Exit codes: `0` ok, `1` the query failed (unknown note, unreadable vault) or `check` found broken links, `2` wrong arguments.

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

`nixe mcp` serves the same queries to agents over MCP: see [mcp.md](mcp.md).
