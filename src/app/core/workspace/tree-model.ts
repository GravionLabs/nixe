import type { DirEntry } from "../file/backend";
import { isMarkdownPath } from "../markdown/paths";

export interface TreeItem {
  /** Display name. */
  name: string;
  /** Folder that can be expanded, if any. */
  dirPath: string | null;
  /** Markdown file opened on click, if any. */
  filePath: string | null;
  /** The folder contains an Azure DevOps `.order` file. */
  hasOrder: boolean;
}

function stem(name: string): string {
  return isMarkdownPath(name) ? name.replace(/\.[^.]+$/, "") : name;
}

/** Azure DevOps wiki file names encode spaces as "-" and hyphens as "%2D". */
export function wikiDisplayName(name: string): string {
  return name.replace(/-/g, " ").replace(/%2D/gi, "-");
}

/**
 * Converts a directory listing into tree items. In Azure DevOps wikis a page
 * with sub-pages is stored as `Page.md` plus a folder `Page/`; both become a
 * single item that opens the page and expands to its sub-pages.
 */
export function buildTreeItems(entries: DirEntry[], parentHasOrder: boolean): TreeItem[] {
  const display = (name: string) => (parentHasOrder ? wikiDisplayName(name) : name);
  const dirNames = new Set(entries.filter((e) => e.isDir).map((e) => e.name));
  const pageFiles = new Map(
    entries.filter((e) => !e.isDir && dirNames.has(stem(e.name))).map((e) => [stem(e.name), e]),
  );

  const items: TreeItem[] = [];
  for (const entry of entries) {
    if (entry.isDir) {
      items.push({
        name: display(entry.name),
        dirPath: entry.path,
        filePath: pageFiles.get(entry.name)?.path ?? null,
        hasOrder: entry.hasOrder,
      });
    } else if (!pageFiles.has(stem(entry.name))) {
      items.push({
        name: parentHasOrder ? display(stem(entry.name)) : entry.name,
        dirPath: null,
        filePath: entry.path,
        hasOrder: false,
      });
    }
  }
  return items;
}

const DEFAULT_PAGES = ["readme.md", "index.md", "home.md"];

/** File to show when a folder is opened: README/index/Home, else the first page. */
export function defaultPage(items: TreeItem[]): string | null {
  for (const name of DEFAULT_PAGES) {
    const hit = items.find((i) => !i.dirPath && i.filePath?.toLowerCase().endsWith("/" + name));
    if (hit) return hit.filePath;
  }
  return items.find((i) => i.filePath)?.filePath ?? null;
}
