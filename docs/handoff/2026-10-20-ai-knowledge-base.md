# Handoff: Nixe as an AI-first knowledge base

Date: 2026-10-20
Branch: `docs/spec-ai-knowledge-base`
Spec: [docs/specs/0001-ai-knowledge-base.md](../specs/0001-ai-knowledge-base.md)

## Goal

Grow Nixe from a Markdown viewer into a knowledge base app (recipes and software
development) for desktop and iOS. Obsidian-compatible vault, Git sync, Claude as author with
diff review. The owner wants to build it (not just use Obsidian), working language is German.

## State

| Item | State |
|---|---|
| Spec 0001 | Written, on branch `docs/spec-ai-knowledge-base`, pushed |
| Pull request | **Not created** (GitHub access in the cloud session was invalid) |
| Epic issue and Feature issues | **Not created**, text is below |
| Crate / name reservation | **Not done** (needs the owner's crates.io login) |
| iOS spike | **Not started** |
| Code changes | None |

## What was found

- `GravionLabs/obsidian-vault-template` (private): ready vault with PARA folders, `CLAUDE.md`
  rules, frontmatter convention, six skills (`/inbox`, `/clip`, `/summarize`, `/meeting`,
  `/decision`, `/weekly-review`) and Obsidian templates. `CLAUDE.md` says "write notes in US
  English"; for the owner's vault this should become German. Recipe template and a `/recipe`
  skill are missing.
- Nixe today: Tauri 2 + Angular, Markdown core is framework-free. No editor, wikilinks,
  backlinks, search, properties view, callouts, plugins, or mobile app.
- Other repos seen but not opened: `schule-vault-template`, `kontex`, `noesis`.

## Decisions so far

- Stay on **Tauri 2** (iOS support exists but is younger; verify in a spike).
- Keep the name **Nixe** (a mermaid; the app renders Mermaid). Reserve candidates if it does not
  work out: Stoa, Mneme, Pinax. **Mise** is out.
- First differentiators: AI changes as reviewable diffs on a branch, mobile capture (dictation,
  photo), plus a recipe mode.

## Checked and not checked

Checked (2026-10-19/20, through web lookups):
- crates.io: `mneme` (event-sourcing lib), `mise` (dev tool, very active), `pinax`, `ruche`,
  `grimoire` taken; `stoa` is a name reservation (27 downloads). `nixe` and `carnet`,
  `hypomnema`: lookup failed, unknown.
- npm: `nixe` is an unmaintained 2016 package; `mneme` and `mise` taken.
- App Store: several apps named Mneme (one is an AI notes app) and several recipe apps named
  Mise. No app named Nixe turned up in a notes/Markdown search (not proof).

Not checked: domains, GitHub organizations, trademarks, versions of the Rust crates listed in
the spec.

## Next steps

1. **iOS spike:** run Nixe in the iOS simulator and clone a repo with `git2`
   (`vendored-libgit2`, `vendored-openssl`). Fallback: GitHub REST API.
2. Open the pull request for this branch and merge the spec.
3. Create the Epic and Feature issues (see below) once GitHub access works.
4. Check `cargo info nixe`; optionally reserve the crate (verified email, token,
   `description` and `license` in `Cargo.toml`, then `cargo publish`; permanent, and crates.io
   discourages squatting).
5. Extend the vault template: recipe template, `/recipe` skill, German language rule, plugin
   config (Obsidian Git, Dataview), `.gitignore` for device files.

## Epic issue text (template "Epic")

- **Title:** `[Epic] Nixe as an AI-first knowledge base (desktop + iOS)`
- **Goal:** Grow Nixe from a Markdown viewer into a knowledge base app: Obsidian-compatible
  vault, Git sync, Claude as author with diff review, mobile capture, recipe and development
  modes.
- **Related spec/ADR:** `docs/specs/0001-ai-knowledge-base.md`
- **Feature candidates:**
  - iOS spike (Tauri build in the simulator, `git2` clone)
  - Core: wikilinks, callouts, properties, backlinks, search, editor
  - Git sync and Claude API client
  - AI branch with diff review
  - Capture and domain modes (recipes, development)

## How to continue

- Local terminal, from a clone of this repo: `claude --teleport <session-id>` (clean git state,
  same claude.ai account, branch pushed). The local copy is separate from the cloud session.
- Or just check out the branch and start a new session; this file and the spec carry the context.
