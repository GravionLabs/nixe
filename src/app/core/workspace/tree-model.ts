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
  /** Last modification in milliseconds since the epoch; 0 when unknown. */
  modified: number;
}

export const TREE_SORTS = ["name-asc", "name-desc", "modified-desc", "modified-asc"] as const;
export type TreeSort = (typeof TREE_SORTS)[number];

export const TREE_SORT_LABELS: Record<TreeSort, string> = {
  "name-asc": "File name (A to Z)",
  "name-desc": "File name (Z to A)",
  "modified-desc": "Modified time (new to old)",
  "modified-asc": "Modified time (old to new)",
};

export function sanitizeTreeSort(value: unknown): TreeSort {
  return TREE_SORTS.find((s) => s === value) ?? "name-asc";
}

/**
 * Orders the items of one folder; folders stay first. "name-asc" keeps the order given (the backend
 * lists by `.order`, then by name), so a wiki's own order survives.
 */
export function sortItems<T extends TreeItem>(items: T[], sort: TreeSort): T[] {
  if (sort === "name-asc") return items;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const compare: (a: T, b: T) => number =
    sort === "name-desc"
      ? (a, b) => byName(b, a)
      : sort === "modified-desc"
        ? (a, b) => b.modified - a.modified || byName(a, b)
        : (a, b) => a.modified - b.modified || byName(a, b);
  const isDir = (i: T) => (i.dirPath !== null ? 0 : 1);
  return [...items].sort((a, b) => isDir(a) - isDir(b) || compare(a, b));
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
        modified: entry.modified ?? 0,
      });
    } else if (!pageFiles.has(stem(entry.name))) {
      items.push({
        name: parentHasOrder ? display(stem(entry.name)) : entry.name,
        dirPath: null,
        filePath: entry.path,
        hasOrder: false,
        modified: entry.modified ?? 0,
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

const COPY_RE = /^(.+) \(conflict \d{4}-\d{2}-\d{2} [^)]+\)(\.[^./\\]*)?$/;

/** The name of the original when `name` is a sync conflict copy (`Note (conflict 2026-11-16 mac).md`). */
export function conflictOriginal(name: string): string | null {
  const m = COPY_RE.exec(name);
  return m ? m[1] + (m[2] ?? "") : null;
}

/**
 * Paths to mark as in conflict: every copy among `paths` and the original next to it. The original
 * is marked only when it is listed too.
 */
export function conflictPaths(paths: readonly string[]): Set<string> {
  const all = new Set(paths);
  const marked = new Set<string>();
  for (const path of paths) {
    const slash = path.lastIndexOf("/");
    const original = conflictOriginal(path.slice(slash + 1));
    if (original === null) continue;
    const originalPath = path.slice(0, slash + 1) + original;
    if (!all.has(originalPath)) continue;
    marked.add(path);
    marked.add(originalPath);
  }
  return marked;
}
