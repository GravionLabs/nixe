import type { BaseCell, BaseCover, BaseLink, BaseResult } from "../../core/file/backend";
import { cellText } from "../bases/cell-text";

/** The folder of the links without a `links` folder role. */
export const DEFAULT_LINKS_FOLDER = "Links";

export type LinkStatus = "unread" | "read";

/** A link note as the Links view shows it. */
export interface LinkItem {
  /** The note, relative to the vault. */
  path: string;
  /** The `title` of the note, else its file name. */
  title: string;
  site: string;
  tags: string[];
  /** The `saved` property as text; empty without one. */
  saved: string;
  status: LinkStatus;
  /** The `http` or `https` address of the page; null without one. */
  url: string | null;
  /** The folder of the collection; empty for a note that is in none. */
  collection: string;
  cover: BaseCover | null;
}

/** What the view shows of the links; null stands for "all". */
export interface LinkFilter {
  collection: string | null;
  tag: string | null;
  status: LinkStatus | null;
}

/** Only `read` is read: a note without a status, or with another one, stays in the inbox. */
export function statusOf(value: string): LinkStatus {
  return value.trim().toLowerCase() === "read" ? "read" : "unread";
}

/** The address, when it is one of the web: the text of a note must not start anything else. */
export function webAddress(text: string): string | null {
  const address = text.trim();
  return /^https?:\/\/\S+$/i.test(address) ? address : null;
}

/**
 * The collection of a note: its folder below the links folder, or its folder in the vault when it
 * is outside of that one.
 */
export function collectionOf(path: string, linksFolder: string): string {
  const folder = path.slice(0, Math.max(path.lastIndexOf("/"), 0));
  if (folder === linksFolder) return "";
  return folder.startsWith(`${linksFolder}/`) ? folder.slice(linksFolder.length + 1) : folder;
}

function tagsOf(cell: BaseCell | undefined): string[] {
  const value = cell?.value;
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  return items.map((item) => String(item).replace(/^#/, "")).filter(Boolean);
}

/** The links of the answer to `links-base.json`, in its order. */
export function linkItems(result: BaseResult, linksFolder: string): LinkItem[] {
  return result.rows.map((row) => {
    const cell = (id: string): BaseCell | undefined =>
      row.cells[result.columns.findIndex((c) => c.id === id)];
    const text = (id: string): string => {
      const found = cell(id);
      return found ? cellText(found) : "";
    };
    const url = cell("url");
    const address = url?.type === "link" ? ((url.value as BaseLink).url ?? "") : text("url");
    const file = row.path.slice(row.path.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
    return {
      path: row.path,
      title: text("title") || file,
      site: text("site"),
      tags: tagsOf(cell("tags")),
      saved: text("saved"),
      status: statusOf(text("status")),
      url: webAddress(address),
      collection: collectionOf(row.path, linksFolder),
      cover: row.cover,
    };
  });
}

/** A collection holds the notes of its sub folders too; tags ignore case. */
export function filterLinks(links: readonly LinkItem[], filter: LinkFilter): LinkItem[] {
  const { collection, status } = filter;
  const tag = filter.tag?.toLowerCase();
  return links.filter(
    (link) =>
      (collection === null ||
        link.collection === collection ||
        link.collection.startsWith(`${collection}/`)) &&
      (tag === undefined || link.tags.some((t) => t.toLowerCase() === tag)) &&
      (status === null || link.status === status),
  );
}

const byName = (a: string, b: string): number => a.localeCompare(b);

/** The collections of the links, with the folders above them. */
export function collections(links: readonly LinkItem[]): string[] {
  const all = new Set<string>();
  for (const { collection } of links) {
    const parts = collection ? collection.split("/") : [];
    parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join("/")));
  }
  return [...all].sort(byName);
}

/** Every tag of the links once, spelled as it is found first. */
export function linkTags(links: readonly LinkItem[]): string[] {
  const all = new Map<string, string>();
  for (const tag of links.flatMap((link) => link.tags))
    if (!all.has(tag.toLowerCase())) all.set(tag.toLowerCase(), tag);
  return [...all.values()].sort(byName);
}
