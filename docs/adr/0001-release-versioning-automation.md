# 0001: Automated, GitVersion-driven releases via GravionLabs/ci

## Status

Proposed

## Context

Releases are currently manual: `.github/workflows/release.yml` builds and tests on every push
and PR, and only builds installers + creates a draft GitHub Release when a `v*` tag is pushed by
hand. `package.json` and `src-tauri/tauri.conf.json` both hardcode `0.1.0`. No tag has been
pushed yet, so Nixe has no release at all.

[GravionLabs/ci](https://github.com/GravionLabs/ci) already provides reusable composite actions
other Gravion repos use for this:

- `versioning/determine-version` — computes a SemVer from git history via
  [GitVersion](https://gitversion.net/), no manual version bumps.
- `versioning/create-version-tag` / `versioning/gh-release` — tags the commit (idempotent) and
  optionally creates the GitHub Release with changelog notes.

## Decision

Adopt `GravionLabs/ci`'s versioning actions instead of hand-pushed tags:

1. Add a `GitVersion.yml` at the repo root configuring the bootstrap version (no existing tags,
   so the first computed version should land on `1.0.0`, matching how `GravionLabs/ci` itself is
   configured).
2. On push to `main`, run `GravionLabs/ci/versioning/determine-version@main` (`fetch-depth: 0`)
   to compute the SemVer, then tag it (`versioning/create-version-tag` or `versioning/gh-release`).
3. Keep the existing `release.yml` build matrix (macOS arm64/x64, Windows, Linux via
   `tauri-apps/tauri-action`) triggered by the `v*` tag push, so it keeps attaching installers to
   the tagged release without changes to the matrix itself.
4. Decide (in the implementing PBI) whether `package.json` / `tauri.conf.json` / `Cargo.toml`
   versions are synced to the GitVersion output or left decoupled — Tauri only needs its own
   version field to be a valid SemVer, it doesn't need to match the git tag.

No existing `GravionLabs/ci` reusable *workflow* (`nuget-package.yml`, `python-package.yml`,
`docker-package.yml`, `node-package.yml`, `angular-package.yml`) covers a multi-platform native
desktop build, so this stays a custom workflow in this repo that calls the versioning actions
directly rather than delegating the whole pipeline.

## Consequences

- Every merge to `main` can produce a new tagged release with no manual tagging step.
- The first run bootstraps Nixe's first public release.
- `GravionLabs/ci` becomes a build-time dependency (pinned via `@main` or a version tag, per its
  own pinning recommendation).
