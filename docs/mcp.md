# MCP server

`nixe mcp` runs a read-only [Model Context Protocol](https://modelcontextprotocol.io) server
over stdio. An agent asks the vault index (the one the app and the [command line](cli.md) use)
instead of scanning files. Before each call the index is brought up to date with an incremental
scan, so answers reflect the files on disk. The server never writes to the vault, unless you start it
with `--allow-clip` (see [Saving links](#saving-links)).

Protocol revision `2026-07-28`, served with the official Rust SDK `rmcp` 3.10 (both checked
against the current specification and crates.io when this was built; the SDK negotiates older
revisions with older clients).

## Claude Code

Add this to the `.mcp.json` at the root of the project (or the vault):

```json
{
  "mcpServers": {
    "nixe": {
      "command": "nixe",
      "args": ["mcp", "--vault", "."]
    }
  }
}
```

`nixe` must be on the `PATH` (the app installs the command; see [cli.md](cli.md)). Without
`--vault` the vault is the one containing the working directory. Or register it once:

```sh
claude mcp add nixe -- nixe mcp --vault /path/to/vault
```

To point agents at it from a vault, put a line like this in the vault's `CLAUDE.md`:

```markdown
Query the vault with the `nixe` MCP server (see docs/mcp.md) before reading many files.
```

## Several folders

`nixe mcp --vault a --vault b` (or `--workspace <name>` for a saved [workspace](workspaces.md))
serves several roots. `search` then covers all of them; each hit has `root` and `rootPath`, and
`root:name` in the query, or the argument `roots: ["name"]`, narrows it. `tags` adds up the counts
and `notes_by_property` lists all roots (each row with its `root`); `backlinks`, `outgoing_links`,
`read_note` and `resolve_link` need the argument `root` as soon as there are several. With one
vault nothing changes.

## Tools

All tools are read-only (`readOnlyHint`), except `clip_link`, which exists only with `--allow-clip`. Results are JSON text with the shapes of
[`--json` in cli.md](cli.md#json-shapes).

| Tool | Arguments | Returns |
|---|---|---|
| `search` | `query` | Notes matching, best first, with matching lines (as `nixe search`). |
| `backlinks` | `note` | Links pointing to the note. |
| `outgoing_links` | `note` | Links, embeds and Markdown links in the note with resolved targets. |
| `tags` | none | Every tag with its note count. |
| `notes_by_property` | `key`, optional `value` | `[{path, title, value}]`: notes having the frontmatter property, optionally equal to (or, for a list, containing) `value`; case-insensitive. |
| `read_note` | `note` | `{path, content}`: the Markdown text. |
| `resolve_link` | `target` | `{path}`: the note a wikilink target names, or `null`. |

`note` is a vault-relative path (with or without `.md`) or a unique note name. Every path in
an argument or a result is vault-relative. An absolute path, a path containing `..` or a note
whose file lies outside the vault (a symlink) is refused with an error result.

## Saving links

`nixe mcp --allow-clip` adds one write tool, `clip_link`, so an agent can save a web page as a
[link note](links.md). Without the flag the tool is not listed and cannot be called: the server
stays read-only.

| Tool | Arguments | Returns |
|---|---|---|
| `clip_link` | `url`, optional `title`, `tags`, `folder`, `vault` | `{path, created}`: the vault-relative path of the note. |

The guarantee: `clip_link` only **creates** new notes, and only inside the links folder (the
role `links` of `.nixe/config.json`, else `Links/`).

- A `folder` must be the links folder or a folder below it; any other folder is refused like a path
  outside the vault. Without `folder` the links folder is used.
- A note is never changed or overwritten. A URL that a link note holds already returns that
  note's path with `created: false`; a new note whose name is taken gets ` 2`, ` 3`, … in its name.
- The index is updated after the write, so the next `search` finds the note.
- `vault` names the vault when the server covers several (as `root` does for the other tools).
  The tool is not available on mobile.
- `clip_link` fetches the page from the network. When the vault's `links.archive` asks for it, the
  archive files go to `.archive` inside the links folder, next to the note.
