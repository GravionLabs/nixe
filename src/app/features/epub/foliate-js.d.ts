/**
 * The part of foliate-js (plain ES modules without types) that Nixe uses. See ADR 0009.
 */
declare module "foliate-js/view.js" {
  export interface FoliateTocItem {
    label: string;
    href: string;
    subitems?: FoliateTocItem[];
  }

  export interface FoliateSection {
    id: string;
    linear?: string;
  }

  export interface FoliateBook {
    metadata: {
      title?: string | Record<string, string>;
      author?: unknown;
      language?: string | string[];
      identifier?: string;
    };
    toc?: FoliateTocItem[];
    sections: FoliateSection[];
  }

  /** The `<foliate-paginator>` inside a view; `flow` is `paginated` or `scrolled`. */
  export interface FoliateRenderer extends HTMLElement {
    next(): Promise<void>;
    prev(): Promise<void>;
    /** Replaces the CSS that is injected into the frames of the book. */
    setStyles?(css: string): void;
  }

  export interface FoliateRelocate {
    /** The table of contents entry that holds the position. */
    tocItem?: { href: string; label: string };
    /** The EPUB CFI of the start of the visible text. */
    cfi?: string;
  }

  /** The `<foliate-view>` element; `view.js` registers it. */
  export interface FoliateView extends HTMLElement {
    renderer: FoliateRenderer;
    open(book: FoliateBook): Promise<void>;
    init(options: { lastLocation?: string | null; showTextStart?: boolean }): Promise<void>;
    goTo(target: string | number): Promise<unknown>;
    next(): Promise<void>;
    prev(): Promise<void>;
    close(): void;
  }

  export function makeBook(file: File): Promise<FoliateBook>;
}
