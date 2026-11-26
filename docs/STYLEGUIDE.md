Extends: node_modules/@gravionlabs/helix-ui/styleguide/STYLEGUIDE.md

# UI style guide

Binding for every UI change. Read the base guide named above first (`pnpm install` puts it there), then this file. This file holds only the rules of Nixe and its deviations; where it says nothing, the base applies. A deviation not listed here needs a reason in the PR.

## Tokens

- A look that a theme or snippet may change is a `--nixe-*` variable of `src/styles.scss`, listed in [theming.md](theming.md). Colors behind these variables are `--h-*` tokens (exceptions: [Deviations](#deviations)).

## Typography and spacing

- Note text in the live preview, source mode and reading view takes its size from `--nixe-note-font-size`; headings, code and widgets in the note use `em`, so they scale with it and with the editor zoom.

## Editor and reader surfaces

- A widget of the live preview takes the background and text size of the note around it.
- The reading view takes its width and padding from `--nixe-content-width` and `--nixe-content-padding-*`.
- The EPUB reader follows the app's light or dark scheme and zoom through `bookCss` ([epub.md](frontend/epub.md)).
- A change made in the properties UI keeps key order, comments and the formatting of the other frontmatter keys.

## Panel layout

- The window is one `hx-app-shell`: toolbar, activity bar, sidebar with the chosen view, main area, right panel, status bar.
- The right panel holds what belongs to the open note, as tabs (Outline, Properties, Links, Related).
- A diff or a review opens as a tab of the main area; the sidebar renders no diff of a history version or a suggestion.
- The right panel is 180 to 640 px wide (default 280) and leaves the note at least 320 px; in a narrower window it overlays the note (`src/app/core/panel/panel-width.ts`).
- Its resize edge is a `role="separator"` that also works with the arrow keys, Home and End.

## Components

- Git, Changes, Review and History are built from `src/app/shared/panel/` (section, note row, status icon, empty state).
- `pnpm lint` (helix-lint) rejects raw controls in templates and hex, rgb and hsl colors and off-scale font sizes in CSS; an exception is an entry with a reason in `scripts/lint/helix-allow.json`.

## UX rules

- The Git view speaks plain language ("3 changes not saved yet"); branch details are secondary text or a tooltip, and raw error text sits under `Details`.

## Cross-platform

- An action of the app is a `Command` in the `CommandRegistry` (`src/app/core/commands/`), so the palette, the native menu and the user's own shortcuts reach it ([frontend](frontend/README.md#commands-and-the-command-palette)).

## Deviations

| Base rule | This project | Reason |
| --- | --- | --- |
| STYLEGUIDE.md, Typography: `font-size` is a `--h-font-size-*` step | App base and note text use `--nixe-font-size` and `--nixe-note-font-size` | Themes, snippets and the setting *Text size* change them ([theming.md](theming.md)) |
| STYLEGUIDE.md, Typography: UI text is `--helix-font-sans`, code `--helix-font-mono` | `--nixe-font-text`, `--nixe-note-text` and `--nixe-font-mono` | Themes and the settings *Text font* and *Code font* change them ([theming.md](theming.md)) |
| STYLEGUIDE.md, Typography: `font-size` is a `--h-font-size-*` step | The wordmark of the start screen is 44 px | A display size above the type scale (`scripts/lint/helix-allow.json`) |
| STYLEGUIDE.md, Typography: `font-size` is a `--h-font-size-*` step | The dot of a folder with changed notes is 8 px | A fixed-size icon glyph (`scripts/lint/helix-allow.json`) |
| STYLEGUIDE.md, Tokens: no literal colors, sizes or shadows in app CSS | `src/styles.scss` has literal diff and danger colors, shadows and font sizes | Open: why not `--h-*` tokens? |
| STYLEGUIDE.md, UX rules: an irreversible action asks through `HxConfirmationService` | Most confirmations use the native `ask` dialog of Tauri | Open: why the native dialog? |
| ux-rules.md, Confirm or undo: no question before a reversible action | Merge, extract, rename and move ask first, although they offer Undo | Open: why ask before an action that can be undone? |
| dialogs.md, Header and size: the width is the `size` input | Dialogs set `width="min(…)"` | Open: why not `size`? |
| platform.md, Platform switch: `providePlatform()` and `getHxPlatform()`, no `navigator.userAgent` | Shortcut and "reveal" labels read `navigator.userAgent`; `providePlatform()` is not provided | Open: why the user agent? |
