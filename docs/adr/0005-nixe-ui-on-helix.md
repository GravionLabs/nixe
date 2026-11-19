# ADR 0005: Nixe UI on helix

- Status: Proposed
- Date: 2026-11-18
- Issues: #197, #198

## Context

Nixe had its own chrome variables (`--bg`, `--chrome`, `--fg`, `--muted`, `--border`, `--hover`,
`--accent`) and switched them with `data-theme` on `<html>`. The other GravionLabs desktop apps use
the helix design system (`@gravionlabs/helix-ui`): the `--h-*` tokens, `HxTheme` and a desktop shell.

## Decision

- **Tokens:** Nixe loads the helix token stylesheet (`@gravionlabs/helix-ui/tokens.css`) and every
  component style uses `--h-*` tokens. Nixe defines no colour variable of its own.
- **One theme switch:** `HxTheme` sets the class `.app-dark` on `<html>`. `SettingsService` keeps the
  stored setting (light, dark, system) and calls `HxTheme.setDark()`; `HxTheme` remembers nothing
  itself. The Markdown (`github-markdown-css`) and highlight.js styles are scoped to `:root.app-dark`
  and `:root:not(.app-dark)`, so the chrome and the document cannot disagree.
- **Shell:** the desktop shell is built from the components of helix-desktop (the next PBIs of #197).
- **iOS:** iOS keeps its own shell; the desktop shell is not shown there. The iOS build starts and shows
  the bundled note (`fixtures/ios.md`).
- **Contrast:** text and controls keep at least 4.5:1 in both themes. The helix error message colour is
  below that, so error text uses `light-dark(var(--h-red-700), var(--h-red-300))`.
  `src/app/theme-tokens.spec.ts` checks the pairs.

## Consequences

- A theme change in helix reaches Nixe with a dependency update; a new helix release installs without
  the 7-day wait of `minimumReleaseAge`.
- The look of Nixe changes to the helix neutrals and primary colour; the layout does not.
