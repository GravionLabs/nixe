# What a vault commits

Nixe's Git sync commits the whole vault. This page lists what belongs into the Git history of a
vault and what does not, and gives the `.gitignore` block that keeps the rest out. See
[ADR 0007](adr/0007-vault-configuration-in-nixe.md) for the reasons behind `.nixe/`.

## Committed

| Path | Why |
|---|---|
| notes (`*.md`) and attachments | the content |
| `.nixe/config.json` | the vault layout, the same on every machine |
| `.nixe/bookmarks.json` | the bookmarks of the vault |
| `.poimen/config.json` | the configuration of the agent panel for the vault |
| `.order` | the manual order of notes and folders |
| `.attachments/` | the attachment folder of the vault |
| `.claude/settings.json` | the shared settings of the agent |
| `.claude/skills/` | the skills of the vault |
| `skills-lock.json` | the pinned versions of the skills |

## Not committed

| Path | Why |
|---|---|
| `.nixe/local/` | state of one machine |
| `.*.nixe-tmp` | temp file of an atomic save |
| `.trash/` | deleted notes of this machine |
| `Links/.archive/` | HTML copies of saved web pages; added when the first one is written (`links.archive`, [links.md](links.md)) |
| `.DS_Store` | macOS folder metadata |
| `.stfolder/` | marker folder of Syncthing |
| `.stversions/` | file versions of Syncthing |
| `.obsidian/workspace*.json` | open tabs and layout of Obsidian, changes on every click |
| `.claude/settings.local.json` | personal settings of the agent |

Conflict copies are notes: commit them, the user resolves them. The index, the caches, the folds,
the window state and the app settings are not in the vault at all (they live in the app data
directory).

## `.gitignore` block

Copy this block to the `.gitignore` of the vault. The vault template
([GravionLabs/obsidian-vault-template](https://github.com/GravionLabs/obsidian-vault-template))
uses the same block.

```gitignore
# Nixe
.nixe/local/
.*.nixe-tmp
.trash/

# Sync tools and the OS
.DS_Store
.stfolder/
.stversions/

# Obsidian and the agent: state of one machine
.obsidian/workspace*.json
.claude/settings.local.json
```

Nixe checks on open that `.nixe/local/`, `.*.nixe-tmp` and `.trash/` are ignored and offers to add
the missing ones under `# Nixe` (**Add to .gitignore** in the Git view). It never removes or
reorders lines.
