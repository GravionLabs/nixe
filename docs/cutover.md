# Cutover from Obsidian

Nixe replaces Obsidian on the desktop when you can do a week of real work without opening
Obsidian. This page is the checklist for that week. `Mod` is ⌘ on macOS and Ctrl elsewhere;
every shortcut can be changed in **Settings → Shortcuts**.

## Daily workflows

| Workflow | The Nixe way | Check |
|---|---|---|
| Capture | `Mod+N` creates a note in the new-note folder of the vault. From a terminal: `nixe new <title>`, `nixe append --inbox <text>` (see [cli.md](cli.md)). | [ ] |
| Daily note | `Mod+Shift+D` opens today's note and creates it from its template. "Open previous / next daily note" are in the palette (`Mod+P`). Folder, date format and template come from `.obsidian/daily-notes.json`. | [ ] |
| Template | In the editor, run **Insert template** from the palette. `{{date}}`, `{{time}}` and `{{title}}` are replaced. | [ ] |
| Link | Type `[[` in the editor; click a link in the reading view to follow it; hover it for a preview. `Mod+Shift+B` shows the backlinks, `Mod+[` and `Mod+]` go back and forward. | [ ] |
| Rename | Select the note in the sidebar and press `F2`, or use **Rename** in its context menu. Open a few notes that link to it afterwards and run **Vault health** (or `nixe check`) to confirm no link broke. | [ ] |
| Search | `Mod+Shift+F` searches the vault (the ⇄ button adds find and replace across the vault: a diff per match, notes and matches can be unchecked, one batch after a confirmation, a Git commit first); `Mod+O` is the quick switcher; `Mod+F` finds in the open note (find and replace in the editor). | [ ] |
| Attach an image | Paste or drop the image into the editor. It is stored in the attachment folder of the vault (**Settings → Files and links**) and linked. | [ ] |
| Sync | `Mod+Shift+S` pulls with rebase and pushes. Auto-commit and auto-sync run on an interval and on focus (**Settings → Git**). A conflict keeps both versions and marks the note. **Git changes** shows what is uncommitted. | [ ] |

Also in daily use: properties panel (edit frontmatter; fold it with `Mod+Alt+P`, or set *Properties in document* to Visible, Folded (default) or Hidden), outline panel (`Mod+Shift+L`), task
checkboxes in the reading view, tabs and split view (`Mod+T`, `Mod+W`, **Split tab to the right**).

## The week

1. Commit the vault so it is clean, then use Nixe and Obsidian on the same vault for a week.
2. At the end of each day run `git diff` in the vault.
3. Expected: only the notes you edited. Not expected: changes to notes you did not touch
   (rewritten links, reformatted frontmatter, changed line endings) or to `.obsidian/`.
   Each of those is a gap.

## Gaps

File every gap as a Bug (something Nixe does wrong) or a PBI (something Obsidian does that Nixe
does not) with the `github-issue` skill. A gap is **blocking** when it forces you to open
Obsidian for a daily workflow above.

The cutover is done when no blocking gap is open.

| Gap | Issue | Blocking |
|---|---|---|
| | | |
