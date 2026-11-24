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

### Dead links

`nixe check --links [--force]` also requests the `url` of every `type: link` note
([links.md](links.md)) and lists the dead ones as a fifth section, `Dead links`, with the
closest [Wayback Machine](https://archive.org/wayback/available) snapshot when there is one. It
exits with `1` when a link is dead. The plain `nixe check` never touches the network. The
`Vault health` view has the same check behind its "Check links" button.

- A request is HEAD, then GET when the server answers 405 or 403. A link is dead on 404, 410, a
  DNS failure or 3 timeouts (10 s each). Every other answer, such as 5xx or a refused connection,
  does not count as dead.
- At most 4 requests run at the same time and requests to one host are 1 s apart (constants in
  `src-tauri/src/links/dead.rs`).
- Results are cached with their check date in the app data directory (`link-check/`), never in the
  vault. A link checked within 7 days is not requested again; `--force` (the "Check all again"
  button) requests every link.
- With `--json` the object gets a `deadLinks` array of `{source, url, reason, snapshot, checked}`
  (`reason`: `404`, `410`, `dns` or `timeout`).

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
| `nixe new <title> [--folder <dir>] [--open]` | Creates an empty note `<title>.md` and never replaces one (exit 1 when it exists). The folder is `--folder` (vault-relative, created if missing), else the new-note folder of `.nixe/config.json` (else `.obsidian/app.json`), else the vault root. `--open` then opens the note in the viewer. |
| `nixe append <note> [text]` | Appends the text (the remaining arguments joined by a space, or stdin when there are none) on its own line(s). A missing note is created: `a/b` is a path in the vault, a bare name goes to `--folder` or the new-note folder. |
| `nixe append --inbox [text]` | Appends to `Inbox.md` in the inbox folder: the new-note folder of the vault when it sets one, else `Inbox/`. |
| `nixe daily [--append <text>]` | The daily note of today: folder, date format and template come from `.nixe/config.json` (else `.obsidian/daily-notes.json`) (the app settings do not reach the command line; the defaults are the vault root and `YYYY-MM-DD`). A missing note is created from its template. With `--append` the text goes on its own line at the end and nothing opens; without it the note opens in the viewer. Prints the path. |

Writes replace the note atomically (a temp file renamed into place) and refuse paths outside
the vault, including `..`, absolute paths and symlinks that lead out. A Nixe window that shows
the note picks the change up through its file watcher.

`<note>` is a vault-relative path (with or without `.md`) or a unique note name, resolved
like a `[[wikilink]]`. A missing or ambiguous note is an error.

## Clip a web page

`nixe clip <url> [--tag <t>]… [--folder <dir>] [--title <t>] [--html <file>|-] [--json] [--open] [--vault <dir>]`
saves a web page as a link note ([links.md](links.md)) and prints the absolute path of the note.
It needs no index.

- Without `--html` the page is fetched (20 seconds, at most 5 MiB). `--html <file>` or `--html -`
  (stdin) uses the HTML you already have, for example a page a browser rendered, and fetches
  nothing. A page that is not UTF-8 is read as ISO-8859-1/windows-1252 when it says so or when
  it is not valid UTF-8; other charsets lose their non-ASCII characters.
- The title is `--title`, else `og:title`, else `<title>`, else the host of the URL. The note
  keeps `description` (`og:description`, else the meta description), `image` (`og:image`) and
  `site` (`og:site_name`, else the host). `url` is the canonical URL of the page when it names an
  absolute `http(s)` one, else the given URL.
- `## Archive` holds the reader text (Readability) as Markdown. A page without readable content
  is saved without `## Archive`; the command warns on stderr and still exits `0`.
- The folder is `--folder` (vault-relative, created if missing), else `Links/`. It must stay
  inside the vault. A note of the same name is never replaced: ` 2`, ` 3`, … is appended.
- `--tag` repeats; a leading `#` is dropped. `--open` opens the note in the viewer.
- `--json` prints `{"path": "/vault/Links/Title.md", "created": true}`.

Exit `1` for an address that is not `http(s)`, a page that cannot be fetched or a folder outside
the vault; `2` for wrong arguments.

## Import bookmarks and Pocket exports

`nixe import-links <file> [--folder <dir>] [--fetch] [--json] [--vault <dir>]` turns an export
into link notes ([links.md](links.md)) and prints `created N, skipped N, failed N`.

- **Formats**, found from the content: Netscape bookmark HTML (the export of Chrome, Firefox,
  Edge and Safari), a Pocket CSV (`title,url,time_added,tags,status`) and the older Pocket HTML.
- Bookmark folders become subfolders of the links folder (`--folder`, else the role `links`,
  else `Links/`). `ADD_DATE` / `time_added` becomes `saved`, `TAGS` / `tags` become tags. A Pocket
  item in the archive (`status` `archive`, or below `Read Archive`) is `status: read`, every other
  note `unread`.
- Without `--fetch` no page is downloaded: the title comes from the export (the host when it has
  none) and the note has no `## Archive`. With `--fetch` every page goes through `nixe clip`
  (reader text and the `links.archive` copies); a page that cannot be fetched is saved from the
  export and reported as a warning on stderr.
- A URL that a link note holds already, and an address that is not `http(s)` (`javascript:`,
  `place:`), is skipped. Exit `1` when a bookmark could not be written.

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
