# Agent guide

Nixe is a Tauri 2 desktop app: an Angular frontend (`src/`) and a Rust core (`src-tauri/`). See `docs/README.md` for the architecture.

## Setup

- Node version: `.nvmrc`. Package manager: pnpm (`pnpm install --frozen-lockfile`).
- Rust: stable toolchain; the crate is `src-tauri/Cargo.toml`.
- Dependencies: a release younger than 7 days is not installed (`minimumReleaseAge` in `pnpm-workspace.yaml`). Renovate (`.github/renovate.json5`, run weekly by `.github/workflows/renovate.yml`) opens the update pull requests against the default branch with the same 7 days from the preset `github>GravionLabs/ci`.
- Workflows reference every action, also those of GravionLabs/ci, by the commit SHA of a release with the version as comment (`owner/action@<sha> # v1.2.3`); Renovate raises the pins.

## Checks

Run these before opening a pull request. CI runs the same.

| What | Command |
|---|---|
| Frontend format (oxfmt) | `pnpm format:check` |
| Frontend lint (oxlint, ESLint for templates, Stylelint for CSS) | `pnpm lint` |
| Frontend tests (Vitest) | `pnpm test` |
| Frontend build | `pnpm build` |
| End-to-end tests (Playwright, demo build; advisory in CI, see `docs/frontend/demo.md`) | `pnpm e2e` |
| Screenshots of the docs and the site (`pnpm screenshots [name...]`; run when a view changes) | `pnpm screenshots` |
| Rust format | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Rust tests leave no temp directories | `pnpm check:temp-dirs` |

Run `pnpm format` (oxfmt, `.oxfmtrc.json`) and `cargo fmt --manifest-path src-tauri/Cargo.toml` to fix formatting. oxfmt formats the TypeScript, the Angular templates, the styles and the JSON/YAML configs; Markdown, `docs/`, `fixtures/` and `src-tauri/` are left out.

`pnpm lint` runs oxlint (`.oxlintrc.json`, type-aware, Angular rules through the `@angular-eslint/eslint-plugin` JS plugin) on the TypeScript, ESLint (`eslint.config.mjs`) on the `.html` templates only and Stylelint (`stylelint.config.mjs`) on `src/**/*.css`; warnings fail it too. The `@gravionlabs/helix-lint` preset in the last two reports a raw `<button>`, `<input>`, `<select>`, `<textarea>` or `<progress>`, hex, rgb and hsl colors, font sizes off the `--h-font-size-*` scale (also in the `font` shorthand) and CSS that selects a native control (`stylelint.config.mjs`); an exception is an entry with a reason in `scripts/lint/helix-allow.json`, and the probe holds one failing sample of each. `pnpm lint:fix` applies the safe fixes. Component templates live in `.html` files: an inline `template:` outside spec files is a lint error. A rule that is turned off or lowered names its reason in a comment. `src/testing/lint-probe/` breaks known rules on purpose; `src/testing/lint-probe.spec.ts` fails when one of them stops being reported, so raise oxlint, oxfmt and oxlint-tsgolint (exact versions) only together and with a green probe.

## UI

- Before changing UI, read the base guide `node_modules/@gravionlabs/helix-ui/styleguide/STYLEGUIDE.md`, then [`docs/STYLEGUIDE.md`](docs/STYLEGUIDE.md), which lists this project's rules and deviations; read a deep-dive file of either when its condition applies. Both are binding: a deviation needs a reason in the PR description.
- Controls are Helix primitives, never a raw `<button>`, `<input>`, `<select>`, `<textarea>` or `<progress>` without a Helix directive; the mapping is [`ng-implementation` `references/helix.md`](.agents/skills/ng-implementation/references/helix.md).
- No component CSS that styles controls; colors and font sizes come from the `--h-*` tokens. `pnpm lint` enforces it (helix-lint: Stylelint for CSS, `helix/no-raw-control` for templates); an exception needs an entry with its reason in `scripts/lint/helix-allow.json`.

## Conventions

- Every change ships with tests. A Rust test that needs a directory uses `TestDir` or `tempfile::TempDir`, never a hand-made name under `env::temp_dir()` (`docs/backend/tests.md`, `pnpm check:temp-dirs`).
- Angular classes keep their role suffix: `*.component.ts` / `…Component`, `*.service.ts` / `…Service`, `*.directive.ts` / `…Directive`, one class per file ([ADR 0012](docs/adr/0012-keep-the-role-suffixes-of-angular-classes.md), also for the allowed exceptions).
- Commits and branches follow the `github-issue` skill; pull requests target `release/next`.
