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
