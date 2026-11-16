# MCP server

`nixe mcp` runs a read-only [Model Context Protocol](https://modelcontextprotocol.io) server
over stdio. An agent asks the vault index (the one the app and the [command line](cli.md) use)
instead of scanning files. Before each call the index is brought up to date with an incremental
scan, so answers reflect the files on disk. The server never writes to the vault.

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

## Tools

All tools are read-only (`readOnlyHint`). Results are JSON text with the shapes of
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
