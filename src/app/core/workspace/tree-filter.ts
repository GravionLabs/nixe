import type { GitChange } from "../file/backend";

/** The letter of a Git status in the file tree: modified, added (staged) or untracked. */
export type TreeGitLetter = "M" | "A" | "U";

export interface TreeGitDecoration {
  /** Status of the notes by absolute path. */
  files: ReadonlyMap<string, TreeGitLetter>;
  /** Folders (absolute path) that contain a note with a status. */
  folders: ReadonlySet<string>;
}

export const NO_DECORATION: TreeGitDecoration = { files: new Map(), folders: new Set() };

/** Maps the changes of the working tree to the paths of the tree; a deleted note has no row. */
export function decorate(changes: readonly GitChange[], vaultRoot: string): TreeGitDecoration {
  const files = new Map<string, TreeGitLetter>();
  const folders = new Set<string>();
  for (const change of changes) {
    if (change.kind === "deleted") continue;
    const path = `${vaultRoot}/${change.path}`;
    files.set(path, change.untracked ? "U" : change.kind === "added" ? "A" : "M");
    for (let at = path.lastIndexOf("/"); at > vaultRoot.length; at = path.lastIndexOf("/", at - 1)) {
      folders.add(path.slice(0, at));
    }
  }
  return { files, folders };
}

/** True when `name` contains the typed text; case does not matter, blanks around the text do not count. */
export function matchesFilter(name: string, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return needle === "" || name.toLowerCase().includes(needle);
}

export interface NamePart {
  text: string;
  match: boolean;
}

/** Splits a name into the parts that match the filter text and the parts that do not. */
export function highlightParts(name: string, filter: string): NamePart[] {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return [{ text: name, match: false }];
  const lower = name.toLowerCase();
  const parts: NamePart[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ text: name.slice(from, at), match: false });
    parts.push({ text: name.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < name.length) parts.push({ text: name.slice(from), match: false });
  return parts;
}

/** The rows of a loaded tree that survive the filter: the matches and the folders on the way to them. */
export function filterTree<T extends { name: string; dirPath: string | null; children(): T[] | null }>(
  nodes: readonly T[],
  filter: string,
): T[] {
  const out: T[] = [];
  const walk = (list: readonly T[]): boolean => {
    let any = false;
    for (const node of list) {
      const at = out.length;
      out.push(node);
      const inside = node.dirPath ? walk(node.children() ?? []) : false;
      if (inside || matchesFilter(node.name, filter)) any = true;
      else out.length = at;
    }
    return any;
  };
  walk(nodes);
  return out;
}
