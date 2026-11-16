/** Pure helpers of the file operations (#69). */

const INVALID_NAME_CHARS = /[\\:*?"<>|#^[\]]/gu;

/** `Untitled.md`, then `Untitled 1.md`, `Untitled 2.md` … the first name not in `taken` (case-insensitive). */
export function uniqueName(taken: Iterable<string>, stem: string, ext: string): string {
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  let name = `${stem}${ext}`;
  for (let n = 1; lower.has(name.toLowerCase()); n++) name = `${stem} ${n}${ext}`;
  return name;
}

/**
 * The vault-relative folder and the file name of a note created from a wikilink target.
 * Characters that are invalid in file names are dropped; null when nothing is left.
 */
export function noteFromLinkTarget(target: string): { folder: string; name: string } | null {
  const hash = target.indexOf("#");
  const parts = (hash >= 0 ? target.slice(0, hash) : target)
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.replace(INVALID_NAME_CHARS, "").trim())
    .filter((p) => p && p !== "." && p !== "..");
  const last = parts.pop();
  if (!last) return null;
  return { folder: parts.join("/"), name: /\.md$/iu.test(last) ? last : `${last}.md` };
}

/** The name typed for a rename: trimmed, without separators; a note keeps its extension when none is typed. */
export function renamedName(oldName: string, typed: string): string | null {
  const name = typed.trim();
  if (!name || name === "." || name === ".." || /[\\/:*?"<>|]/u.test(name)) return null;
  const ext = /^.+(\.[^./\\]+)$/u.exec(oldName)?.[1] ?? "";
  if (/\.md$/iu.test(ext) && !/\.[^.]+$/u.test(name)) return name + ext;
  return name;
}

/** `path` after `from` was renamed to `to`; unchanged when it is not `from` or below it. */
export function remapPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return path.startsWith(from + "/") ? to + path.slice(from.length) : path;
}
