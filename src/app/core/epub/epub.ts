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
