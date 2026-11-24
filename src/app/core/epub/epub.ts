import type { FoliateBook, FoliateTocItem } from "foliate-js/view.js";

/** A book that is read and parsed; the reader tab shows it (#487). */
export interface EpubBook {
  /** The file the book was read from. */
  path: string;
  /** The title of the book, or the file name without `.epub` when the book has none. */
  title: string;
  book: FoliateBook;
}

export type EpubFlow = "paginated" | "scrolled";

/** A row of the table of contents with its depth, subitems flattened in reading order. */
export interface TocRow {
  label: string;
  href: string;
  depth: number;
}

/** The title of a book; the metadata holds a text or a text per language. */
export function bookTitle(book: FoliateBook, fallback: string): string {
  const raw = book.metadata.title;
  const title =
    typeof raw === "string" ? raw : (Object.values(raw ?? {}).find((t) => t.trim() !== "") ?? "");
  return title.trim() === "" ? fallback : title.trim();
}

/** The table of contents as one list in reading order. */
export function flattenToc(items: readonly FoliateTocItem[] | undefined, depth = 0): TocRow[] {
  return (items ?? []).flatMap((item) => [
    { label: item.label.trim() || item.href, href: item.href, depth },
    ...flattenToc(item.subitems, depth + 1),
  ]);
}

/** The saved reading position of a book: a CFI, with the book it belongs to (#489). */
export interface EpubPosition {
  root: string;
  path: string;
  cfi: string;
}

/** The name of a book for the store: the root name and the path relative to that root. */
export function positionKey(root: string, relPath: string): string {
  return `${root}:${relPath}`;
}

/** The CFI of a stored position; a damaged text, another shape or another book gives `null`. */
export function parsePosition(text: string | null, root: string, relPath: string): string | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { cfi, root: r, path: p } = value as Partial<EpubPosition>;
    if (typeof cfi !== "string" || cfi === "" || r !== root || p !== relPath) return null;
    return cfi;
  } catch {
    return null;
  }
}

/** The colors of the book in the light and the dark theme of the app. */
const BOOK_COLORS = {
  light: { background: "#ffffff", text: "#1f2328", link: "#0b57d0" },
  dark: { background: "#1e1f22", text: "#dfe1e5", link: "#8ab4f8" },
} as const;

/**
 * The CSS that the reader injects into every frame of the book (foliate-js `setStyles`): the colors
 * of the app theme and the app zoom as the size of the text (100 = the size of the book).
 * Inline style in a frame of a `blob:` URL falls under `style-src 'unsafe-inline'` of the app.
 */
export function bookCss(dark: boolean, zoom: number): string {
  const c = BOOK_COLORS[dark ? "dark" : "light"];
  const size = Math.round(zoom);
  return `
    html { color-scheme: ${dark ? "dark" : "light"}; background: ${c.background}; color: ${c.text}; }
    body { background: ${c.background}; color: ${c.text}; }
    a:link, a:visited { color: ${c.link}; }
    html { font-size: ${size}% !important; }
    body, p, li, dd, dt, td, th, blockquote { font-size: inherit; }
  `;
}
