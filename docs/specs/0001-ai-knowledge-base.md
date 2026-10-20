# Spec 0001: Nixe as an AI-first knowledge base (desktop + iOS)

## Status

Draft

## Context

Nixe is a Markdown viewer today (Tauri 2 + Angular). The goal is to grow it into a knowledge
base app for personal notes (recipes and software development) that works on desktop and iOS,
syncs through Git, and treats Claude as a first-class author.

The vault format stays compatible with Obsidian: plain Markdown, `[[wikilinks]]`, YAML
frontmatter, `![[embeds]]`. The template vault is
[GravionLabs/obsidian-vault-template](https://github.com/GravionLabs/obsidian-vault-template)
(PARA structure, `CLAUDE.md` rules, six skills).

### Gaps compared with Obsidian

Nixe has no editor, no wikilinks/embeds, no backlinks or graph, no search or quick switcher, no
frontmatter/properties view, no callouts, no tags/aliases, no templates or daily notes, no
queries (Dataview/Bases), no canvas, no plugins, and no mobile app. It is better at Azure DevOps
wikis, KaTeX, zoomable Mermaid, and CLI startup.

## Differentiators (what Obsidian does not offer)

1. **AI changes as review.** Claude never writes into notes directly. It works on a branch and
   the user accepts or rejects each diff in the app, like a pull request.
2. **Mobile capture.** Dictate a recipe or photograph a cookbook page and get a structured note
   in the vault.
3. **Visible provenance.** Every statement has a source; content Claude added from general
   knowledge is marked (`> [!info] Added context (not from the source)`) and shown distinctly.
4. **Domain modes.**
   - Recipe: scale servings, shopping list across recipes, cooking mode with timers.
   - Development: ADRs, runnable snippets, Mermaid diagrams (already supported).
5. **Librarian in the background.** Claude finds duplicates, broken links, and orphan notes and
   proposes fixes, reviewed like point 1.
6. **No lock-in.** Plain Markdown; skills and rules live in the repo; the vault still opens in
   Obsidian.

Suggested start: 1 and 2, plus the recipe mode from 4. Everything else later.

## Decisions

### Stay on Tauri 2

Tauri 2 supports iOS and Android, the Markdown core is already framework-free, and Rust fits
Git (`git2`). Risks: the iOS target is younger than desktop, some plugins are desktop-only,
file access in the iOS sandbox (iCloud folders) and background sync are hard, and camera /
speech / share extension need native Swift code.

**Validate first with a spike:** run Nixe in the iOS simulator and clone a Git repo with
`git2` (with `vendored-libgit2` and `vendored-openssl`). Fall back to the GitHub REST API if
this fails.

### Name

Keep **Nixe** (a Nixe is a mermaid; the app renders Mermaid). Considerations:

- "nixe" sounds like "nix" (German "nothing", the Nix package manager). A suffix such as
  "Nixe Notes" can help in stores.
- npm has an unmaintained `nixe` package (2016). No app named Nixe turned up in an App Store
  search for notes/Markdown apps (not proof). The crates.io lookup failed; check with
  `cargo info nixe`.
- Domains, GitHub organizations, and trademarks are not checked.
- Fallbacks considered: Stoa, Mneme (crate and several App Store apps exist), Pinax. Mise is out
  (the dev tool `mise` and several recipe apps).

### Reserve the crate name

Optional. A placeholder crate `nixe` on crates.io needs a verified email, an API token, a
`description` and `license` in `Cargo.toml`, then `cargo publish`. Publishing is permanent
(versions can only be yanked), and crates.io policy discourages squatting. The Tauri package in
`src-tauri/Cargo.toml` does not need to be published. `nixe-core` etc. only matter if the
Markdown core becomes a real library.

## Rust dependencies

Already used: `tauri` (`protocol-asset`), `tauri-plugin-dialog`, `tauri-plugin-opener`,
`tauri-plugin-single-instance`, `serde`, `serde_json`, `notify-debouncer-mini`, `dunce`.

Versions were not verified. Check crates.io before adding.

| Task | Crate | Note |
|---|---|---|
| Git sync (clone, pull, push, branches) | `git2` | libgit2 bindings. For iOS enable `vendored-libgit2` and `vendored-openssl`. This is the risky part. |
| Alternative to git2 | `gix` | Pure Rust, easier to cross-compile. Push support is less mature as far as known; verify. |
| AI changes as diff | `similar` | Text diff for the review view. `git2` can also produce diffs. |
| Claude API and GitHub API | `reqwest` (`rustls-tls`), `tokio`, `futures-util` | Streaming responses and REST. No official Rust SDK known; write the calls by hand. |
| Store API key securely | `keyring` | Keychain on macOS and iOS, Credential Manager on Windows. |
| Walk files | `ignore` (or `walkdir`) | Respects `.gitignore`; good for large vaults. |
| Full-text search | `tantivy` | Indexed search. A simple `grep-searcher` approach is enough to start. |
| Quick switcher (fuzzy) | `nucleo` | Same technology as the Helix editor. |
| Read frontmatter | `gray_matter` | `serde_yaml` is archived. |
| Wikilinks and backlinks | `comrak` or `pulldown-cmark` | `comrak` supports wikilinks. Alternatively stay with markdown-it in the frontend. |
| Index for backlinks and tags | `rusqlite` (feature `bundled`) | Small SQLite cache to avoid rescanning. |
| Errors, logging | `thiserror`, `anyhow`, `tracing` | Standard. |

Tauri plugins to consider: `tauri-plugin-fs`, `tauri-plugin-store`, `tauri-plugin-http`,
`tauri-plugin-deep-link`, and for mobile `tauri-plugin-biometric` (Face ID to protect the
token). Camera, photos, speech input, and the iOS share extension have no official plugin as far
as known; plan native Swift code and verify in the spike.

## Phases

1. **Spike (iOS):** simulator build, clone a repo with `git2`, read/write a file in the app
   sandbox.
2. **Core:** wikilinks, embeds, callouts, frontmatter/properties view, backlinks, search and
   quick switcher, editor (CodeMirror 6 is the likely choice).
3. **Git and AI:** sync (pull/push), Claude API client with key in the keychain, AI branch plus
   diff review.
4. **Capture and modes:** recipe mode, development mode, mobile capture (photo, voice).
5. **Later:** librarian jobs, semantic search through an API (local embeddings such as
   `fastembed` are heavy on mobile).

## Open questions

- Editor component: CodeMirror 6 or something lighter?
- Git on iOS: `git2` with vendored OpenSSL, or the GitHub REST API?
- iCloud versus Git as the primary sync path on iOS (do not combine them on one folder).
- Should AI branches be per run or one long-lived branch per vault?
