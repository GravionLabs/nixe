/** Bookmarks as a tree of notes, headings, searches and groups; the file format is Obsidian's. No Angular. */

export interface FileBookmark {
  type: "file";
  /** Vault-relative path. */
  path: string;
  /** `#Heading` for a heading, empty for the whole note. */
  subpath?: string;
  title?: string;
  ctime?: number;
}

export interface SearchBookmark {
  type: "search";
  query: string;
  title?: string;
  ctime?: number;
}

export interface GroupBookmark {
  type: "group";
  title: string;
  items: Bookmark[];
  ctime?: number;
}

/** A kind Obsidian knows and Nixe does not show (folder, graph, url, …): kept as it is. */
export interface OtherBookmark {
  type: string;
  [key: string]: unknown;
}

export type Bookmark = FileBookmark | SearchBookmark | GroupBookmark | OtherBookmark;

/** The whole file: the bookmarks, and every other top-level key kept as it was. */
export interface BookmarkFile {
  items: Bookmark[];
  extra: Record<string, unknown>;
}

/** The position of an item: the index in the root, then the index in each group below. */
export type ItemPath = readonly number[];

export const EMPTY: BookmarkFile = { items: [], extra: {} };

export function isFile(b: Bookmark): b is FileBookmark {
  return b.type === "file" && typeof (b as FileBookmark).path === "string";
}

export function isSearch(b: Bookmark): b is SearchBookmark {
  return b.type === "search" && typeof (b as SearchBookmark).query === "string";
}

export function isGroup(b: Bookmark): b is GroupBookmark {
  return b.type === "group" && Array.isArray((b as GroupBookmark).items);
}

function clean(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: Bookmark[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const b = item as Bookmark;
    if (typeof b.type !== "string") continue;
    if (b.type === "group") {
      out.push({
        ...b,
        title: typeof b["title"] === "string" ? (b["title"] as string) : "",
        items: clean(b["items"]),
      } as GroupBookmark);
    } else if ((b.type === "file" && !isFile(b)) || (b.type === "search" && !isSearch(b))) {
      continue;
    } else {
      out.push(b);
    }
  }
  return out;
}

/** Reads the text of a bookmarks file; a missing or damaged one is empty. */
export function parseBookmarks(text: string | null): BookmarkFile {
  if (!text) return { items: [], extra: {} };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { items: [], extra: {} };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json))
    return { items: [], extra: {} };
  const { items, ...extra } = json as Record<string, unknown>;
  return { items: clean(items), extra };
}

/** True when the text is there but is no bookmarks file (damaged, half synced): it must not be overwritten. */
export function isDamaged(text: string | null): boolean {
  if (!text?.trim()) return false;
  try {
    const json = JSON.parse(text) as unknown;
    return typeof json !== "object" || json === null || Array.isArray(json);
  } catch {
    return true;
  }
}

export function serializeBookmarks(file: BookmarkFile): string {
  return JSON.stringify({ ...file.extra, items: file.items }, null, 2);
}

/** The bookmarks of one vault inside the app data file (one entry per vault root). */
export function parseAppStore(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const json = JSON.parse(text) as unknown;
    return typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function itemAt(items: readonly Bookmark[], path: ItemPath): Bookmark | null {
  let list: readonly Bookmark[] = items;
  let found: Bookmark | null = null;
  for (const i of path) {
    found = list[i] ?? null;
    if (!found) return null;
    list = isGroup(found) ? found.items : [];
  }
  return found;
}

/** Applies `change` to the list at `parent` (empty: the root) and returns the new tree. */
function editList(
  items: Bookmark[],
  parent: ItemPath,
  change: (list: Bookmark[]) => Bookmark[],
): Bookmark[] {
  if (parent.length === 0) return change([...items]);
  const [head, ...rest] = parent;
  return items.map((b, i) =>
    i === head && isGroup(b) ? { ...b, items: editList(b.items, rest, change) } : b,
  );
}

/** The text a bookmark shows. */
export function labelOf(b: Bookmark): string {
  if (isFile(b)) {
    if (b.title) return b.title;
    const name = b.path.slice(b.path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
    return b.subpath ? `${name} ${b.subpath}` : name;
  }
  if (isSearch(b)) return b.title || b.query;
  if (isGroup(b)) return b.title || "Group";
  const title = (b as OtherBookmark)["title"];
  return typeof title === "string" ? title : b.type;
}

/** True when the same note, heading or search is already bookmarked (anywhere in the tree). */
export function contains(
  items: readonly Bookmark[],
  probe: FileBookmark | SearchBookmark,
): boolean {
  return items.some((b) => {
    if (isGroup(b)) return contains(b.items, probe);
    if (probe.type === "file")
      return isFile(b) && b.path === probe.path && (b.subpath ?? "") === (probe.subpath ?? "");
    return isSearch(b) && b.query === probe.query;
  });
}

/** Appends a bookmark at the end of the root, unless it exists already. */
export function addBookmark(
  items: Bookmark[],
  bookmark: FileBookmark | SearchBookmark,
  now: number,
): Bookmark[] {
  if (contains(items, bookmark)) return items;
  return [...items, { ...bookmark, ctime: now }];
}

/** Removes the first bookmark equal to `probe`, wherever it is. */
export function removeMatching(
  items: Bookmark[],
  probe: FileBookmark | SearchBookmark,
): Bookmark[] {
  let done = false;
  const walk = (list: Bookmark[]): Bookmark[] =>
    list.flatMap((b) => {
      if (isGroup(b)) return [{ ...b, items: walk(b.items) }];
      const same =
        probe.type === "file"
          ? isFile(b) && b.path === probe.path && (b.subpath ?? "") === (probe.subpath ?? "")
          : isSearch(b) && b.query === probe.query;
      if (same && !done) {
        done = true;
        return [];
      }
      return [b];
    });
  return walk(items);
}

export function removeAt(items: Bookmark[], path: ItemPath): Bookmark[] {
  if (path.length === 0) return items;
  return editList(items, path.slice(0, -1), (list) =>
    list.filter((_, i) => i !== path[path.length - 1]),
  );
}

export function addGroup(items: Bookmark[], title: string, now: number): Bookmark[] {
  return [...items, { type: "group", title, items: [], ctime: now }];
}

export function renameGroup(items: Bookmark[], path: ItemPath, title: string): Bookmark[] {
  const target = itemAt(items, path);
  if (!target || !isGroup(target)) return items;
  return editList(items, path.slice(0, -1), (list) =>
    list.map((b, i) => (i === path[path.length - 1] ? { ...target, title } : b)),
  );
}

function isPrefix(prefix: ItemPath, path: ItemPath): boolean {
  return prefix.length <= path.length && prefix.every((v, i) => path[i] === v);
}

/**
 * Moves the item at `from` so that it ends up at index `index` of the list at `parent` (empty: the
 * root), counted in the list as it is before the move. A group cannot move into itself.
 */
export function moveItem(
  items: Bookmark[],
  from: ItemPath,
  parent: ItemPath,
  index: number,
): Bookmark[] {
  const item = itemAt(items, from);
  if (!item || isPrefix(from, parent)) return items;
  const fromParent = from.slice(0, -1);
  const fromIndex = from[from.length - 1]!;
  // Removing the item first shifts later siblings of the same list, and every path through that list.
  let target = [...parent];
  let at = index;
  if (
    target.length > fromParent.length &&
    isPrefix(fromParent, target) &&
    target[fromParent.length]! > fromIndex
  ) {
    target[fromParent.length] = target[fromParent.length]! - 1;
  }
  if (target.length === fromParent.length && isPrefix(fromParent, target) && at > fromIndex)
    at -= 1;
  const without = removeAt(items, from);
  return editList(without, target, (list) => {
    list.splice(Math.min(Math.max(at, 0), list.length), 0, item);
    return list;
  });
}

/** Rewrites the paths after a note or folder moved from `from` to `to` (vault-relative). */
export function renamePath(items: Bookmark[], from: string, to: string): Bookmark[] {
  const remap = (p: string): string | null =>
    p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : null;
  return items.map((b) => {
    if (isGroup(b)) return { ...b, items: renamePath(b.items, from, to) };
    if (isFile(b) || (b.type === "folder" && typeof b["path"] === "string")) {
      const next = remap((b as FileBookmark).path);
      return next === null ? b : { ...b, path: next };
    }
    return b;
  });
}

/** The line of a heading bookmark (`#Heading`) among `headings`; null when it is gone. */
export function headingLine(
  subpath: string | undefined,
  headings: readonly { text: string; line: number }[],
): number | null {
  if (!subpath?.startsWith("#") || subpath.startsWith("#^")) return null;
  const wanted = subpath.slice(1).trim().toLowerCase();
  return headings.find((h) => h.text.trim().toLowerCase() === wanted)?.line ?? null;
}
