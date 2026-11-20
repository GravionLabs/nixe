# Changelog

All notable changes to GravionLabs/nixe are documented here.
Versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.5.0] — 2026-11-20

### Bug Fixes
- **shell**: Helix desktop shell is not fully styled, tab bar renders unstyled (#222) (#224)


### Features
- **viewer**: Center the note content like Obsidian (#223) (#226)
- **git**: History of a note with a diff between versions (#105) (#227)
- **git**: Restore an older version of a note (#106) (#228)
- **git**: Show what changed since the last sync (#107) (#254)
- **review**: List branches waiting for review and show their changes per note (#108) (#255)
- **review**: Accept or reject changes per note and hunk and merge the result (#109) (#256)


## [1.4.0] — 2026-11-19

### Bug Fixes
- **deps**: Exempt the helix packages from the minimum release age (#212)


### Documentation
- Update CHANGELOG.md for v1.4.0 [skip ci]


### Features
- **tabs**: HxTabBar and settings and vault health as tabs (#200) (#211)
- **shell**: Activity bar with one active sidebar view (#199) (#218)
- **status-bar**: Always visible with Git, zoom, version and update state (#201) (#219)
- **toolbar**: Slim toolbar for the open note (#202) (#220)


### Refactoring
- **theme**: Adopt the helix tokens and HxTheme (#198) (#209)
- **styles**: CSS as the default, keep styles.scss as the documented exception (#216) (#217)


## [1.3.4] — 2026-11-18

### Bug Fixes
- **index**: Retry the WAL switch while another opener holds the new database (#207)


### Documentation
- Update CHANGELOG.md for v1.3.4 [skip ci]


## [1.3.3] — 2026-11-18

### Documentation
- Update CHANGELOG.md for v1.3.3 [skip ci]


## [1.3.2] — 2026-11-18

### Bug Fixes
- **deps**: Renovate opens its pull requests against the default branch (#203)


### Documentation
- Update CHANGELOG.md for v1.3.2 [skip ci]


## [1.3.1] — 2026-11-18

### Bug Fixes
- **deps**: 7-day minimum release age (#193)


### Documentation
- Update CHANGELOG.md for v1.3.1 [skip ci]


## [1.3.0] — 2026-11-17

### Bug Fixes
- **git**: Keep both versions on a conflict and mark the note (#76) (#173)
- **ci**: Grant pull-requests: write to the pr-checks job (#191) (#192)
- **updater**: Set the updater public key (#168) (#190)
- **updater**: Align the npm plugin with the crate version (#194) (#195)


### Documentation
- Update CHANGELOG.md for v1.3.0 [skip ci]


### Features
- **git**: Show the vault's Git status and commit with a message (#73) (#169)
- **git**: Store the HTTPS token in the OS keychain (#74) (#171)
- **git**: Pull with rebase and push with a sync command (#75) (#172)
- **git**: Keep both versions on a conflict and mark the note (#76) (#173)
- **git**: Auto-commit and auto-sync on an interval and on focus (#77) (#174)
- **git**: Clone a vault from a URL (#78) (#175)
- **templates**: Insert templates with {{date}}, {{time}} and {{title}} (#79) (#177)
- **daily-notes**: Open today's daily note (#80) (#178)
- **editor**: Paste and drop attachments into the attachment folder (#81) (#179)
- **properties**: Edit properties in the properties panel (#82) (#180)
- **outline**: Outline panel of the open note (#83) (#181)
- **vault**: Open, switch and remember vaults (#84) (#182)
- **editor**: Find and replace in the note (#95) (#183)
- **viewer**: Toggle task checkboxes in the reading view (#96) (#184)
- **workspace**: Tabs and split view (#97) (#185)
- **viewer**: Preview a note when hovering a link (#98) (#186)
- **settings**: Settings page (#99) (#187)
- **settings**: Customizable keyboard shortcuts (#100) (#188)
- **updater**: Auto-update via tauri-plugin-updater (#168) (#176)


## [1.2.0] — 2026-11-16

### Bug Fixes
- **ci**: Add release notes to the GitHub release (#167) (#159)


### Documentation
- Update CHANGELOG.md for v1.2.0 [skip ci]


### Features
- **cli**: Query the vault from the command line (#101) (#161)
- **mcp**: Read-only MCP server for the vault (#102) (#163)
- **cli**: Create notes and append text from the command line (#103) (#164)
- **health**: Vault health view and `nixe check` (#104) (#165)
- **editor**: Toggle the editor from the toolbar (#160) (#166)


## [1.1.0] — 2026-11-16

### Bug Fixes
- Link fragments created a wrong note name, and the inline rename
- **release**: Build the Windows MSI with a numeric pre-release version (#150)
- **release**: Derive the MSI version from any pre-release label
- **release**: Build pre-releases without an MSI


### Documentation
- Update roadmap, README and architecture docs for ADR 0003 (#86) (#141)


### Features
- Render callouts, ==highlights== and %%comments%% (#20) (#136)
- Detect the vault root and resolve [[wikilinks]] to notes (#18) (#135)
- Render ![[embeds]] of notes, headings, blocks and images (#19) (#142)
- **index**: Extract note metadata in the Rust core (#62) (#143)
- **index**: Build the vault index in SQLite with typed properties and full text (#63) (#144)
- **index**: Keep the index current through a vault-wide file watcher (#64) (#145)
- **backlinks**: Backlinks panel with outgoing and unresolved links (#65) (#146)
- **search**: Full-text search panel with tag and path filters (#66) (#147)
- **switcher**: Quick switcher with fuzzy matching over titles and aliases (#67) (#148)
- **release**: SHA256SUMS for the installers (#48) (#140)
- **editor**: Edit the open note in CodeMirror 6 with styled Markdown and save to disk (#68) (#154)
- **vault**: Create, rename and delete notes and folders (#69) (#155)
- **vault**: Rewrite wikilinks in referring notes on rename or move (#70) (#156)
- **editor**: Wikilink and tag autocomplete (#71) (#157)
- **commands**: Command registry and command palette (#72) (#158)


## [1.0.7] — 2026-11-15

### Bug Fixes
- Team ID, spike commands in release builds and signing env handling (#129) (#130)


### Documentation
- **adr**: Record the iOS go/no-go and the Git strategy (#61) (#127)


### Security
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)
- **ios**: Clone, commit and push a repository with git2 on the iPhone (#60) (#125)


## [1.0.5] — 2026-11-01

### Documentation
- Spec 0001, roadmap and plugin system spec for the AI knowledge base (#33)
- Drop the Obsidian rewrite, keep Nixe a lean viewer (#9)


## [1.0.0] — 2026-09-28


