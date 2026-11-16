# Agent guide

Nixe is a Tauri 2 desktop app: an Angular frontend (`src/`) and a Rust core (`src-tauri/`). See `docs/README.md` for the architecture.

## Setup

- Node version: `.nvmrc`. Package manager: pnpm (`pnpm install --frozen-lockfile`).
- Rust: stable toolchain; the crate is `src-tauri/Cargo.toml`.

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
