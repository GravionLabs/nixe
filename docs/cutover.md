# Cutover from Obsidian

Nixe replaces Obsidian on the desktop when you can do a week of real work without opening
Obsidian. This page is the checklist for that week. `Mod` is ⌘ on macOS and Ctrl elsewhere;
every shortcut can be changed in **Settings → Shortcuts**.

## Daily workflows

| Workflow | The Nixe way | Check |
|---|---|---|
| Capture | `Mod+N` creates a note in the new-note folder of the vault. From a terminal: `nixe new <title>`, `nixe append --inbox <text>` (see [cli.md](cli.md)). | [ ] |
| Daily note | `Mod+Shift+D` opens today's note and creates it from its template. "Open previous / next daily note" are in the palette (`Mod+P`). Folder, date format and template come from `.nixe/config.json` (`daily`), imported from `.obsidian/` when the vault is opened. | [ ] |
| Template | In the editor, run **Insert template** from the palette. `{{date}}`, `{{time}}` and `{{title}}` are replaced. | [ ] |
| Link | Type `[[` in the editor; click a link in the reading view to follow it; hover it for a preview. `Mod+Shift+B` shows the backlinks, `Mod+[` and `Mod+]` go back and forward. | [ ] |
| Rename | Select the note in the sidebar and press `F2`, or use **Rename** in its context menu. Open a few notes that link to it afterwards and run **Vault health** (or `nixe check`) to confirm no link broke. | [ ] |
| Search | `Mod+Shift+F` searches the vault (the ⇄ button adds find and replace across the vault: a diff per match, notes and matches can be unchecked, one batch after a confirmation, a Git commit first); `Mod+O` is the quick switcher; `Mod+F` finds in the open note (find and replace in the editor). | [ ] |
| Attach an image | Paste or drop the image into the editor. It is stored in the attachment folder of the vault (**Settings → Files and links**) and linked. | [ ] |
| Sync | `Mod+Shift+S` pulls with rebase and pushes. Auto-commit and auto-sync run on an interval and on focus (**Settings → Git**). A conflict keeps both versions and marks the note. **Git changes** shows what is uncommitted. What the vault commits and the `.gitignore` block: [vault-git.md](vault-git.md). | [ ] |

Also in daily use: properties panel (edit frontmatter; fold it with `Mod+Alt+P`, or set *Properties in document* to Visible, Folded (default) or Hidden), outline panel (`Mod+Shift+L`), task
checkboxes in the reading view, tabs and split view (`Mod+T`, `Mod+W`, **Split tab to the right**).

## Settings in `.nixe/`

When you open a vault that has no `.nixe/config.json`, Nixe imports the new-note folder, the template
folder, the daily-note settings and the bookmarks from `.obsidian/` into `.nixe/config.json` and
`.nixe/bookmarks.json` once. Commit them with the vault. Nixe never writes `.obsidian/`, so Obsidian
still works with the vault in the cutover week; change a setting for Nixe in `.nixe/config.json`
(see [ADR 0007](adr/0007-vault-configuration-in-nixe.md)).

## The week

1. Commit the vault so it is clean, then use Nixe and Obsidian on the same vault for a week.
2. At the end of each day run `git diff` in the vault.
3. Expected: only the notes you edited. Not expected: changes to notes you did not touch
   (rewritten links, reformatted frontmatter, changed line endings) or to `.obsidian/` (Nixe must not write there; `.nixe/` is expected to change once, at the import).
   Each of those is a gap.

## Gaps

File every gap as a Bug (something Nixe does wrong) or a PBI (something Obsidian does that Nixe
does not) with the `github-issue` skill. A gap is **blocking** when it forces you to open
Obsidian for a daily workflow above.

The cutover is done when no blocking gap is open.

| Gap | Issue | Blocking |
|---|---|---|
| | | |
