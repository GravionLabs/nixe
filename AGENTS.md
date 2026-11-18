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
| Frontend tests (Vitest) | `pnpm test` |
| Frontend build | `pnpm build` |
| Rust format | `cargo fmt --manifest-path src-tauri/Cargo.toml --check` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |

Run `cargo fmt --manifest-path src-tauri/Cargo.toml` to fix formatting. There is no lint check for the frontend yet.

## Conventions

- Every change ships with tests.
- Commits and branches follow the `github-issue` skill; pull requests target `release/next`.
