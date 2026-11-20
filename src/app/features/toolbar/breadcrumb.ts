import { basename } from "../../core/markdown/paths";

export interface Crumb {
  /** Shown text; `…` for the folders left out. */
  label: string;
  /** Absolute folder of a folder segment; null for the note and the ellipsis. */
  dir: string | null;
  kind: "folder" | "ellipsis" | "note";
}

/** Folders shown at most before the middle is left out: the first one and the last one. */
const MAX_FOLDERS = 3;

/**
 * The path of the note as segments. Inside the vault: the folders from the vault root and the
 * note; outside it, only the file name. A path with more than `MAX_FOLDERS` folders keeps the
 * first and the last folder and replaces the ones in between with `…`; the note always stays.
 */
export function breadcrumb(path: string | null, vaultRoot: string | null): Crumb[] {
  if (!path) return [];
  const note: Crumb = { label: basename(path), dir: null, kind: "note" };
  if (!vaultRoot || !path.startsWith(`${vaultRoot}/`)) return [note];
  const parts = path.slice(vaultRoot.length + 1).split("/");
  parts.pop();
  const folders: Crumb[] = parts.map((label, i) => ({
    label,
    dir: `${vaultRoot}/${parts.slice(0, i + 1).join("/")}`,
    kind: "folder",
  }));
  if (folders.length > MAX_FOLDERS) {
    return [folders[0], { label: "…", dir: null, kind: "ellipsis" }, ...folders.slice(-2), note];
  }
  return [...folders, note];
}
