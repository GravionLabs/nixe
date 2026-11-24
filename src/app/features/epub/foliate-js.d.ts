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

  export function makeBook(file: File): Promise<FoliateBook>;
}
