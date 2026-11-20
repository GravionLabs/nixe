# Themes and CSS snippets

The look of Nixe is adjustable with plain CSS. Nothing here needs a restart: a theme switches at once and a changed file is read again within a few seconds.

## Where the files live

In the app config directory (**Settings → Appearance → Themes and snippets folder** shows the path):

| Folder | What | Active |
|---|---|---|
| `themes/*.css` | A theme. | One at a time, chosen under *Custom theme*. |
| `snippets/*.css` | A small change. | Each one switched on and off on its own. |

Both folders are created on the first start. The name of the file without `.css` is its name in the settings. Hidden files, files above 2 MB and files that are not UTF-8 are ignored.

The order is: app styles, theme, snippets, then the settings *Accent color*, *Text font* and *Code font*. A later rule wins over an earlier one of the same specificity, so a snippet can refine a theme and the settings refine both.

Obsidian themes and `.obsidian/snippets/` are **not** loaded. They target Obsidian's DOM and class names (`.workspace-leaf`, `.markdown-preview-view`, …), which Nixe does not have. Copy the colors and fonts you want into a Nixe theme using the variables below.

## Variables

Set them on `:root`:

```css
:root {
  --nixe-font-text: "Inter", sans-serif;
  --nixe-content-width: 760px;
}
```

### Nixe variables

| Variable | Default | What |
|---|---|---|
| `--nixe-font-text` | system UI font | Font of the app and the rendered note. |
| `--nixe-font-mono` | system monospace | Font of code in the rendered note. |
| `--nixe-font-size` | `14px` | Base font size of the app. |
| `--nixe-line-height` | `1.5` | Line height of the rendered note. |
| `--nixe-note-text` | `var(--nixe-font-text)` | Font of the rendered note only. |
| `--nixe-radius` | `6px` | Corner radius. |
| `--nixe-content-width` | `980px` | Maximum width of the rendered note. |
| `--nixe-content-padding-x` | `40px` | Left and right padding of the note. |
| `--nixe-content-padding-top` | `32px` | Top padding of the note. |
| `--nixe-content-padding-bottom` | `80px` | Bottom padding of the note. |
| `--nixe-accent` | `var(--h-primary-500)` | Accent color. The setting *Accent color* sets it and the `--h-primary-400` to `--h-primary-700` shades. |
| `--nixe-link-color` | `var(--nixe-accent)` | Links in the note. |
| `--nixe-selection-background` | accent at 30% | Selected text. |
| `--nixe-callout-radius` | `var(--nixe-radius)` | Corners of callouts. |

### Colors

Every color of the app and of the note is a Helix token, `--h-*`, defined for the light scheme on `:root` and for the dark one on `.app-dark` (on `<html>`). Override them in the same way:

```css
:root { --h-content-background: #fffdf7; }
.app-dark { --h-content-background: #14161a; }
```

| Variable | What |
|---|---|
| `--h-content-background` | Background of panels and the note. |
| `--h-surface-frame` | Frame around the panels (toolbar, status bar). |
| `--h-surface-hover` | Hover and selected rows. |
| `--h-text-color`, `--h-text-muted-color` | Text and secondary text. |
| `--h-content-border-color`, `--h-border-panel`, `--h-border-divider` | Borders and dividers. |
| `--h-primary-color`, `--h-primary-contrast-color` | Primary action and the text on it. |
| `--h-primary-50` … `--h-primary-950` | The accent scale. |
| `--h-surface-0` … `--h-surface-950` | The neutral scale. |
| `--h-message-error-background`, `--h-message-error-border-color` | Error messages. |

The code highlighting and the Markdown colors (`.markdown-body`) come from the GitHub styles, scoped by `:root:not(.app-dark)` and `:root.app-dark`. Override them with a rule of equal or higher specificity, for example `:root .markdown-body blockquote { … }`.

### Spacing

Spacing is set by `--nixe-content-*` for the note and by the `--h-*` spacing tokens of the components. The sizes of the chrome (sidebar width, panel layout) are settings of the app, not CSS.

## From Obsidian

| Obsidian | Nixe |
|---|---|
| `--font-text`, `--font-text-theme`, `--font-interface` | `--nixe-font-text` |
| `--font-monospace`, `--font-monospace-theme` | `--nixe-font-mono` |
| `--font-text-size` | `--nixe-font-size` |
| `--line-height-normal` | `--nixe-line-height` |
| `--file-line-width` | `--nixe-content-width` |
| `--radius-s`, `--radius-m` | `--nixe-radius` |
| `--interactive-accent`, `--color-accent` | `--nixe-accent` |
| `--text-accent`, `--link-color` | `--nixe-link-color` |
| `--text-selection` | `--nixe-selection-background` |
| `--background-primary` | `--h-content-background` |
| `--background-secondary` | `--h-surface-frame` |
| `--background-modifier-hover` | `--h-surface-hover` |
| `--background-modifier-border` | `--h-content-border-color` |
| `--text-normal` | `--h-text-color` |
| `--text-muted`, `--text-faint` | `--h-text-muted-color` |
| `--background-modifier-error` | `--h-message-error-background` |

Selectors do not map: Nixe renders the note in `.markdown-body` (GitHub's Markdown CSS), not in `.markdown-preview-view`.

## Safety

The settings *Accent color*, *Text font* and *Code font* are checked before they are used: a color must be `#rgb` or `#rrggbb`, a font list may not contain `;`, braces, comments or `url(`. Themes and snippets are your own CSS and run with the rights of any stylesheet: they cannot run scripts, but they can hide parts of the app.
