import { assetFilePath } from "../markdown/image-zoom";

/** Page sizes of the print stylesheet (CSS `@page size`). */
export const PAGE_SIZES = ["A3", "A4", "A5", "Letter", "Legal"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = "A4";

export type ExportFormat = "html" | "pdf";

/** What an export looks like; the settings give the defaults, the command line overrides them. */
export interface ExportOptions {
  dark: boolean;
  pageSize: PageSize;
  /** A page break before every top-level heading (`h1`) except a first one. */
  pageBreaks: boolean;
}

/** The page size named by `value` (any case); the default for an unknown one. */
export function sanitizePageSize(value: unknown): PageSize {
  if (typeof value !== "string") return DEFAULT_PAGE_SIZE;
  const wanted = value.trim().toLowerCase();
  return PAGE_SIZES.find((s) => s.toLowerCase() === wanted) ?? DEFAULT_PAGE_SIZE;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/gu, (c) => ESCAPES[c]);
}

/** The title of a note: its file name without folder and `.md`. */
export function noteTitle(path: string): string {
  const name = path.split(/[\\/]/u).pop() ?? path;
  return name.replace(/\.md$/iu, "");
}

/** Wikilinks point to notes the reader does not have: they become their plain text. */
export function plainWikilinks(root: ParentNode): void {
  for (const link of Array.from(root.querySelectorAll("a.wikilink, a[data-wikilink]"))) {
    link.replaceWith(...Array.from(link.childNodes));
  }
}

/** Parts of the viewer that only work inside the app. */
export function stripAppControls(root: ParentNode): void {
  root
    .querySelectorAll(".code-tools, .code-copy, [contenteditable], script")
    .forEach((el) => el.remove());
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-line], [data-zoomable]"))) {
    el.removeAttribute("data-line");
    el.removeAttribute("data-zoomable");
    el.removeAttribute("tabindex");
    if (el.getAttribute("role") === "button") el.removeAttribute("role");
  }
}

/**
 * Replaces the local images of `root` by `data:` URIs. `read` gets the file path and returns the
 * URI (`null` when it cannot be read: the image keeps its address). Remote images stay as they are.
 */
export async function inlineImages(
  root: ParentNode,
  read: (path: string) => Promise<string | null>,
): Promise<void> {
  const cache = new Map<string, Promise<string | null>>();
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const path = assetFilePath(img.getAttribute("src"));
    if (!path) continue;
    let uri = cache.get(path);
    if (!uri) {
      uri = read(path).catch(() => null);
      cache.set(path, uri);
    }
    const data = await uri;
    if (data) img.setAttribute("src", data);
  }
}

/** A style rule as the browser reports it (`CSSRule.cssText`). */
const FONT_FACE = /^@font-face/u;
const THEME_ROOT = /^(?::root|html)[^{]*\{[^}]*--h-/u;
const CONTENT_RULE =
  /\.(?:markdown-body|katex|hljs|callout|mermaid-diagram|mermaid-error|properties?|property-[\w-]+|frontmatter-warning|tag|embed[\w-]*)\b/u;

/** True for a rule of the page stylesheet that styles rendered note content. */
export function isContentRule(cssText: string): boolean {
  if (FONT_FACE.test(cssText)) return /KaTeX/u.test(cssText);
  return THEME_ROOT.test(cssText) || CONTENT_RULE.test(cssText);
}

/** The `cssText` of every rule of `sheets` that styles note content, in order. */
export function collectContentCss(
  sheets: Iterable<{ cssRules: Iterable<{ cssText: string }> }>,
): string {
  const out: string[] = [];
  for (const sheet of sheets) {
    let rules: { cssText: string }[];
    try {
      rules = Array.from(sheet.cssRules);
    } catch {
      continue; // a stylesheet of another origin cannot be read
    }
    for (const rule of rules) if (isContentRule(rule.cssText)) out.push(rule.cssText);
  }
  return out.join("\n");
}

/**
 * Keeps the `woff2` source of every `@font-face` of `css` and inlines it through `read` (the URL
 * as written in the stylesheet → a `data:` URI, or `null`); the old formats are dropped.
 */
export async function inlineFonts(
  css: string,
  read: (url: string) => Promise<string | null>,
): Promise<string> {
  const faces = css.match(/@font-face\s*\{[^}]*\}/gu) ?? [];
  let out = css;
  for (const face of faces) {
    const url = /url\(\s*["']?([^"')]+?\.woff2)["']?\s*\)/u.exec(face)?.[1];
    if (!url) continue;
    const data = await read(url).catch(() => null);
    if (!data) continue;
    out = out.replace(face, face.replace(/src\s*:[^;}]*/u, `src: url(${data}) format("woff2")`));
  }
  return out;
}

/** The stylesheet of the print view: no app chrome, page size, optional break before each `h1`. */
export function printCss(options: ExportOptions): string {
  return `@page { size: ${options.pageSize}; margin: 18mm; }
@media print {
  html, body { background: #fff; }
  html.app-dark, html.app-dark body { background: #0d1117; }
  html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .markdown-body { max-width: none; margin: 0; padding: 0; }
  .markdown-body pre, .markdown-body blockquote, .markdown-body img, .markdown-body table,
  .markdown-body .mermaid-diagram, .markdown-body .katex-display, .markdown-body .callout {
    break-inside: avoid;
  }
  .markdown-body h1, .markdown-body h2, .markdown-body h3 { break-after: avoid; }
  .markdown-body pre { white-space: pre-wrap; }
${options.pageBreaks ? "  .markdown-body h1:not(:first-child) { break-before: page; }\n" : ""}}`;
}

/** Styles of the standalone page that the app stylesheet does not bring along. */
const BASE_CSS = `body { margin: 0; }
.markdown-body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 32px 40px 80px; background: transparent; }
.markdown-body .mermaid-diagram { margin: 1em 0; text-align: center; overflow-x: auto; }
.markdown-body .mermaid-diagram svg { max-width: 100%; height: auto; }
.markdown-body .embed { margin: 1em 0; padding: 0 1em; border-left: 3px solid #8b949e66; border-radius: 4px; }
.markdown-body .embed-title { font-size: 0.85em; padding-top: 0.5em; opacity: 0.8; }
.markdown-body .embed.embed-placeholder .embed-body { font-style: italic; opacity: 0.7; padding-bottom: 0.5em; }
.markdown-body .callout { margin: 1em 0; padding: 0.5em 1em; border: 1px solid #8b949e66; border-radius: 6px; }
.markdown-body .callout-title { font-weight: 600; }
.markdown-body .mermaid-error { color: #cf222e; }`;

export interface HtmlDocument {
  title: string;
  /** The rendered note, sanitized; images, diagrams and math already inline. */
  body: string;
  /** Content styles (see `collectContentCss`, `inlineFonts`). */
  css: string;
  options: ExportOptions;
}

/** One self-contained HTML file: no script, no link to a file or a stylesheet. */
export function buildHtmlDocument(doc: HtmlDocument): string {
  const { options } = doc;
  const scheme = options.dark ? "dark" : "light";
  return `<!doctype html>
<html lang="en" class="${options.dark ? "app-dark" : ""}" style="color-scheme: ${scheme}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>
${doc.css}
${BASE_CSS}
html.app-dark body { background: #0d1117; }
${printCss(options)}
</style>
</head>
<body>
<article class="markdown-body">
${doc.body}
</article>
</body>
</html>
`;
}
