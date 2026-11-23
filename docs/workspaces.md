# Workspaces

A workspace shows several folders ("roots") in one window. **Add folder to workspace…** (palette)
adds a root below the open folder; **Save workspace** stores the list under a name, and each saved
workspace is a palette command **Open workspace: _name_**.

- **Kind per root.** The backend detects it: `obsidian` (has `.obsidian/`; a subfolder of a vault is
  added as the vault), `wiki` (an Azure DevOps wiki: `.order` or `.attachments/`), else `folder`.
- **Own links and index per root.** A root's wikilinks resolve against that root's own files, so two
  roots can both have a `Todo.md`. The vault index is one SQLite file per root path.
- **Saved in the app data directory** as `workspaces/<name>.json`; nothing is written into the
  folders, and forgetting a workspace leaves them. A saved root whose folder is gone is skipped on
  opening.

## Location variables

A root path may start with `$Name/…`, which is resolved on the device that opens the workspace
([ADR 0008](adr/0008-location-variables-and-own-root-names-for-portable-workspaces.md)). The built-ins
are `$Home` and `$Documents` (the home and documents folder of the Tauri path API; the command line
reads `HOME`/`USERPROFILE` and uses `Documents` below it). `$$` at the start is a literal `$`
(`$$Archive/notes` is the folder `$Archive/notes`); a `$` anywhere else in a path is literal.

A root keeps both: `path` is the resolved absolute path that the rest of the core works with,
`template` the path as written. The file `workspaces/<name>.json` stores the template in place of
`path`, so it holds no path of one device, and a file without templates (older versions) loads
unchanged. A root whose variable has no value on the device keeps the template as its `path`,
which is no folder, so it is skipped like a missing folder; saving writes the template back.
`$OneDrive` is the `OneDrive` environment variable on Windows and the folder
`~/Library/CloudStorage/OneDrive-*` on macOS; with several such folders (several accounts) it stays
unresolved and names the candidates until the user picks one. `$iCloud` is
`~/Library/Mobile Documents/com~apple~CloudDocs` on macOS. Linux has neither. The messages for an
unresolved variable follow in a later issue (#462).

### Own variables

The section **Locations** of the settings page lists the own variables of the device
(`Books = D:\Cloud\Bücher`) and adds, edits, renames and removes them; the section is found by the
settings search by its title, the name or the folder of a variable. A variable needs a name of
letters, digits and `_`, which is none of the built-in names (`Home`, `Documents`, `OneDrive`,
`iCloud`; any case), and an existing absolute folder; otherwise the page shows why it is refused and
changes nothing. The resolver reads them like the built-ins (`$Books/notes`), so a workspace root
written that way finds its folder on every device that defines `Books`.

They are stored per device in `locations.json` next to `settings.json` in the app data directory
(`{"variables": {"Books": "D:\\Cloud\\Bücher"}, "onedrive": "<picked folder>"}`), never in a workspace
or in the vault. The command line reads the same file. The OneDrive account picked among several
(`$OneDrive`) is stored in it as `onedrive` (Tauri command `locations_choose_onedrive`); a stored
folder that is no candidate any more is ignored. A damaged file counts as empty.

## Links between roots

A link resolves inside the root of the note that holds it. To reach a note of another root, prefix
the target with the name of that root and a colon (the name is the folder name, shown in the
sidebar; case-insensitive):

```md
[[Wiki:Onboarding]]
[[Wiki:folder/Page#Heading]]
```

The prefix is only used when it names a root; otherwise the colon belongs to the note name
(`[[Re: plan]]`). Root names are unique in a workspace (`notes`, `notes (2)`). The rule is
implemented by `WorkspaceLinks` in `src-tauri/src/workspace.rs`.

## Search and quick switcher

The search panel and the quick switcher cover all roots (#117). Every result shows its root, and
the operator `root:name` (`root:"two words"`; case-insensitive) keeps the notes of one root, in
the panel and in the switcher alike. Opening the workspace scans the further roots into their
own indexes in the background (`workspace_index`); the search reads all indexes
(`search_workspace`, `workspace_notes`) and ranks the hits of all roots together by FTS rank, at
most 50. Ten roots with 5000 notes in total answer in well under 150 ms
(`ten_roots_with_5000_notes_answer_within_150_ms`). A further root is scanned once when the
workspace opens; its later changes are picked up on the next opening (no file watcher on further
roots).

The command line and the MCP server take several `--vault` arguments or `--workspace <name>`
([cli.md](cli.md), [mcp.md](mcp.md)).

## Limits

File operations (create, rename, write) and the Git integration still work on the first root, the
one the window was opened with; the further roots are for browsing and reading. Only the first root
is watched and in the live index of the window (backlinks); links in notes of a further root
open through the workspace resolution above.
