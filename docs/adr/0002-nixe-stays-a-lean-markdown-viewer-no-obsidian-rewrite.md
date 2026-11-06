# ADR 0002: Nixe stays a lean Markdown viewer; no Obsidian rewrite

- Status: Superseded by [ADR 0003](0003-nixe-becomes-a-vault-app-with-editing-and-git-sync.md)
- Date: 2026-11-01
- Issues: #9

## Context

The plan of 2026-10-20 ([spec 0001](https://github.com/GravionLabs/nixe/blob/81302cde9d24/docs/specs/0001-ai-knowledge-base.md),
[spec 0002](https://github.com/GravionLabs/nixe/blob/81302cde9d24/docs/specs/0002-plugin-system.md),
[roadmap](https://github.com/GravionLabs/nixe/blob/81302cde9d24/docs/roadmap.md)) grew Nixe into an
Obsidian replacement for desktop and iOS: vault index, editor, Git sync, Claude as author,
plugin system and a Tauri iOS app.

The real problem behind it is syncing one vault across macOS, Linux, iPhone and iPad with a
history. That problem is independent of the editor:

- Obsidian with the obsidian-git plugin syncs through Git on desktop and iOS. A custom Git
  plugin would not do better on iOS, because Obsidian plugins run there as JavaScript only.
- Claude as author works without an app of its own: Claude Code edits the vault repository on
  a branch, and the change is reviewed as a pull request on GitHub.
- Domain modes (recipes, ADRs, librarian) can be Obsidian plugins.

The rewrite would have needed about 15 PBIs (M0–M2) just to reach parity with Obsidian, plus
the unproven Tauri iOS and `git2` risk, before offering anything Obsidian lacks.

## Decision

We do not rewrite Obsidian. Nixe stays a lean, fast Markdown viewer (Tauri 2 + Angular) with
its existing strengths: Azure DevOps wikis, KaTeX, zoomable Mermaid, fast CLI startup.

As an optional extension, Nixe displays Obsidian vaults **read-only** (#11: wikilinks, embeds,
callouts, highlights, comments, properties, tags):

- Nixe never writes into a vault: no `.nixe/` directory, no settings migration, no cache.
- `.obsidian/` only marks the vault root.
- Wikilinks resolve against an in-memory file list; there is no persistent index.

Editing, sync, history and the Claude workflow stay in Obsidian, obsidian-git, Git and GitHub.

## Consequences

- Easier: the scope shrinks to #11 (#18–#21); no iOS build, no editor, no index, no plugin API
  to maintain. Nixe stays small and starts fast.
- Easier: the vault is never touched by Nixe, so it cannot break Obsidian or Git sync.
- Harder: no backlinks, search or quick switcher in Nixe; tags and unresolved links are not
  clickable targets. Those needs are served by Obsidian.
- The Features #10 and #12–#16 and the PBIs #17 and #22–#32 are closed as not planned. Spec
  0001, spec 0002 and the handoff of 2026-10-20 are removed; the links above keep them
  readable.

## Alternatives

- **Obsidian rewrite in Nixe (the previous plan).** Rejected: very large effort to reach
  parity, loses the Obsidian plugin ecosystem, and the iOS risk sits exactly on the sync
  problem it was meant to solve.
- **Own Git plugin for Obsidian.** Rejected: on iOS it would run on the same JavaScript Git
  implementation as obsidian-git.
- **Native iOS sync app.** Only worth reconsidering if obsidian-git turns out to be unusable on
  iOS for the vault; even then a small sync app is enough, not an Obsidian clone.
