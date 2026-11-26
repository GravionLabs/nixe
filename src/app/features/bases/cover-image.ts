import { convertFileSrc } from "@tauri-apps/api/core";

import type { BaseCover } from "../../core/file/backend";
import { joinPath } from "../../core/markdown/paths";

/** The address the image of a card cover loads from; null for a color and without a cover. */
export function coverImage(cover: BaseCover | null, root: string | null): string | null {
  if (cover?.type === "url") return cover.value;
  // An image of the vault loads like one in a note.
  if (cover?.type === "path" && root) return convertFileSrc(joinPath(root, cover.value));
  return null;
}
