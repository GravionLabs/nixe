import { isMarkdownPath } from "./paths";

export interface WikilinkTarget {
  /** Note part without heading/block; "" for a link to the current note (`[[#Heading]]`). */
  note: string;
  /** `[[Note#Heading]]` */
  heading: string | null;
  /** `[[Note#^block]]` */
  block: string | null;
}

/** Splits the `data-target` of a wikilink into note, heading and block id. */
export function parseWikilinkTarget(target: string): WikilinkTarget {
  const hash = target.indexOf("#");
  const note = (hash >= 0 ? target.slice(0, hash) : target)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  const fragment = hash >= 0 ? target.slice(hash + 1).trim() : "";
  if (fragment.startsWith("^")) return { note, heading: null, block: fragment.slice(1) || null };
  return { note, heading: fragment || null, block: null };
}

/**
 * Maps a wikilink target to a path in `files` (vault-relative, forward slashes) by Obsidian's rules:
 * an exact relative path first, then a unique basename anywhere in the vault; case-insensitive.
 * Returns null when the target is missing or ambiguous.
 */
export function resolveWikilink(target: string, files: readonly string[]): string | null {
  const { note } = parseWikilinkTarget(target);
  if (!note) return null;
  const names = isMarkdownPath(note) ? [note] : [`${note}.md`, note];

  for (const name of names) {
    if (files.includes(name)) return name;
  }
  for (const name of names) {
    const lower = name.toLowerCase();
    const exact = files.filter((f) => f.toLowerCase() === lower);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    // "folder/Note" or "Note": the path or basename anywhere in the vault.
    const suffix = files.filter((f) => f.toLowerCase().endsWith("/" + lower));
    if (suffix.length === 1) return suffix[0];
    if (suffix.length > 1) return null;
  }
  return null;
}
