# Spec 0002: Plugin system

## Status

Draft, 2026-10-20. Feature: [#16](https://github.com/GravionLabs/nixe/issues/16). Roadmap
milestone M5, after the vault editor (M2).

## Context

Nixe will carry domain modes (recipes, software development), capture flows and user-specific
extensions. Putting all of them into the core makes the app heavy for everyone and ties every
idea to a core release. Obsidian's success rests on its plugin ecosystem; Nixe needs the same
lever, scaled to a small project: one person maintains the core, plugins come from the owner
first and from others later.

Constraints that shape the design:

- The frontend is Angular, the Markdown core is framework-free TypeScript, the backend is Rust
  behind Tauri commands with an allowlist (`src-tauri/capabilities/default.json`).
- iOS is a target. Apple allows JavaScript that runs inside WebKit, but forbids apps that
  download and execute native code or offer code in a store-like interface. Obsidian's
  "community plugins" live within that rule.
- Claude is a first-class author: the vault already carries `CLAUDE.md` and skills under
  `.claude/skills/`. A domain mode such as recipes needs a skill (`/recipe`), a template and UI
  together, so a plugin should be able to ship all three.

## Goals

1. Plugins extend rendering, commands, panels and note handling without touching the core.
2. The built-in features use the same extension points as plugins (no second mechanism).
3. A plugin can be shared with a vault (checked into the repo) or installed per app.
4. Installation works offline from a folder and online from a registry.
5. Plugins run on desktop and iOS without native code.

Non-goals for v1: Obsidian plugin compatibility, native (Rust) plugins, a sandbox with
fine-grained permissions, a paid marketplace.

## Plugin model

A plugin is a folder:

```
my-plugin/
  manifest.json      id, name, version, minAppVersion, description, author, main, styles,
                     platforms ["desktop","ios"], skills ["skills/recipe"], templates ["..."]
  main.js            ES module with `export default class extends Plugin { onload(); onunload() }`
  styles.css         optional
  skills/            optional Claude skills (same layout as .claude/skills/<name>/SKILL.md)
  templates/         optional note templates
```

Locations, searched in this order:

| Location | Scope | Synced how |
|---|---|---|
| `<vault>/.nixe/plugins/<id>/` | this vault, every device | with the vault through Git |
| `<app-data>/plugins/<id>/` | this app installation | not synced |
| built-in (bundled with the app) | everyone | with the app |

Enabled plugins are listed in `<vault>/.nixe/plugins.json` (vault scope) and the app settings
(app scope). A plugin can be disabled, reloaded and removed from a settings page.

Loading: the loader reads the manifest, checks `minAppVersion` and `platforms`, imports
`main.js` as an ES module from a `blob:` URL (or through the Tauri asset protocol), injects
`styles.css`, constructs the class with an `App` handle and calls `onload()`. `onunload()` must
remove everything the plugin registered; the API returns disposables to make that easy. The
CSP in `tauri.conf.json` must allow `blob:` module scripts; verify this on iOS early.

## API v1 (`@nixe/plugin-api`)

A small, typed surface published to npm as types plus a thin runtime. Plugins are written in
TypeScript or plain JavaScript, bundled with esbuild from a template repository. Angular is not
part of the API; views receive a DOM element.

| Area | Calls | Backed by |
|---|---|---|
| Markdown | `registerMarkdownItPlugin(plugin)`, `registerPostProcessor(fn(el, ctx))` | the markdown-it pipeline in `core/markdown/` |
| Commands | `addCommand({ id, name, hotkey?, when?, run })` | `CommandRegistry` (#31) |
| Views | `registerView(type, factory)`, `openView(type)`, `addStatusBarItem()`, `addRibbonIcon()` | panel host in the shell |
| Vault | `vault.read(path)`, `write`, `create`, `rename`, `trash`, `list()`, `on('changed')` | the file commands and the watcher |
| Metadata | `metadata.get(path)` (links, tags, frontmatter, headings), `backlinks(path)`, `search(q)` | the index (#22) |
| Settings | `loadData()`, `saveData()`, `addSettingTab(render)` | `tauri-plugin-store` under the plugin id |
| Editor | `registerEditorExtension(ext)` (CodeMirror 6), `getSelection()`, `replaceSelection()` | the editor (#27) |
| AI | `registerSkill(path)`, `ai.run(skill, input)` | the Claude integration (M4) |
| Events | `on('note-opened' | 'index-updated' | 'layout-ready', handler)` | app events |

Every registration returns a disposable, and the loader disposes everything on unload.

Versioning: the API follows semver; `minAppVersion` in the manifest gates loading. Breaking
changes get a new major with a migration note. The built-in recipe mode is developed against
the API before the API is published, so that the first external release is already proven.

## Security and trust

Plugins run in the WebView with the same rights as the app: they can read and write the whole
vault and call every Tauri command in the allowlist. This is Obsidian's model and the right
trade-off for v1: a sandbox (iframes with `postMessage`) would cost most of the UI integration
and does not prevent vault damage, which is the realistic risk. Mitigations that are cheap:

- Plugins get only the Tauri commands the app already exposes; nothing in the plugin API grants
  a new native capability. The allowlist stays as small as the app needs.
- A plugin is loaded only after the user enabled it explicitly, once per vault; a vault from
  Git that contains plugins shows them as "found, disabled" first.
- The registry is curated (pull request per plugin, review of the repository), as Obsidian does.
- Git is the undo: a damaged vault is recoverable from history, which is one more reason the Git
  sync comes before the plugin system.

## Distribution

Options considered:

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Git-based registry** (recommended) | A repository `GravionLabs/nixe-plugins` holds `plugins.json` (`id`, `name`, `repo`, `description`). Each plugin is a GitHub repository that publishes releases with `manifest.json`, `main.js`, `styles.css` as assets. The app fetches the list raw from GitHub and the assets from the release API. | No server, proven by Obsidian, curation through pull requests, releases are immutable and versioned, offline install is the same folder format. | GitHub API rate limits unauthenticated (60/h); a token from the Git sync removes that. Plugins must be on GitHub. |
| B. npm packages | Keyword `nixe-plugin`, install by downloading the tarball. | Semver, dependency resolution, existing tooling. | Tarballs with transitive dependencies in the app, no curation, registry search is weak, extra download path for iOS. |
| C. Vault-local only | Plugins live in `.nixe/plugins/` and travel with the vault. | Zero infrastructure, works today, team shares plugin set via Git. | Not a distribution channel on its own; updates are manual. |
| D. Nixe-hosted index | A JSON index and asset mirror on a GravionLabs server or GitHub Pages. | Independent of GitHub API limits, can add signatures and stats later. | A server to run; not needed until the plugin count is large. |

Recommendation: **A plus C.** The registry is the catalogue, GitHub Releases are the download,
and the install target is either the vault folder (synced) or the app folder (local). The
"community plugins" page in the app shows name, description, author, repository link and
version, and installs or updates with one click. The wording in the app avoids "store". D can be
added later without changing the plugin format.

Updates: the app compares the installed `version` with the latest release on demand and on a
daily check, never automatically installs, and shows release notes from the GitHub release.

Signing is out of scope for v1. When it becomes necessary, releases get a detached signature
(`minisign`) and `plugins.json` carries the public key per plugin.

## Relation to Claude skills

Skills in the vault (`.claude/skills/`) are already a plugin mechanism for the AI layer, and
they work without Nixe (Claude Code reads them). A Nixe plugin that ships skills copies or links
them into `.claude/skills/` on enable and removes them on disable, so the vault stays usable
with plain Claude Code. The reverse is also true: a vault with skills but without Nixe plugins
is fine.

## Platforms

- **Desktop:** everything above.
- **iOS:** JavaScript plugins load the same way (WebKit executes them). The plugin page must
  not look like a store; installing from the registry is "community plugins", as in Obsidian.
  No `dlopen`, no WASM with JIT; a later WASM option would use an interpreter (`wasmi`) and be
  compiled into the app, not downloaded.
- **Native plugins** (Rust) are not in v1. If a plugin needs native capability (camera, speech),
  that capability is added to the core behind a Tauri command, and the plugin uses the API.

## Phasing

1. **M1–M2 (core):** the Markdown pipeline, command registry, panels and index are registries;
   built-in features register through them. No external loading yet.
2. **M5 (plugin system):** manifest, loader, lifecycle, API v1, settings page, vault and app
   folders. The recipe mode is built as a built-in plugin against the API.
3. **M5 (distribution):** `@nixe/plugin-api` on npm, a template repository, the registry
   repository, the community plugins page with install and update.
4. **Later:** signatures, a hosted index, WASM plugins, editor live-preview extensions.

## Open questions

- Loading mechanism for `main.js` in the WebView: `blob:` module URL versus the asset protocol
  (CSP and iOS behavior decide).
- Does the vault-scope plugin folder get its own name (`.nixe/`) or go under `.obsidian/` to
  stay invisible to Obsidian's file explorer? `.nixe/` is cleaner; `.obsidian/` is hidden
  already. Leaning `.nixe/`.
- Settings storage per plugin: one JSON file per plugin in the vault (synced, like Obsidian's
  `data.json`) or the app store (local). Probably both, chosen by the plugin.
- Whether built-in modes (recipe, development) ship as plugins that are enabled by default, or
  stay compiled in. Shipping as plugins validates the API; the cost is load time.
