/** Helpers for the zoom dialog of images in the viewer (see ViewerComponent). */

/**
 * The file path behind a local image URL, i.e. the inverse of Tauri's `convertFileSrc`
 * (`asset://localhost/<encoded path>` or `http(s)://asset.localhost/<encoded path>`).
 * Remote, `data:` and `blob:` images have no file: `null`.
 */
export function assetFilePath(src: string | null | undefined): string | null {
  if (!src) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  const isAsset = url.protocol === "asset:" || url.hostname === "asset.localhost";
  if (!isAsset) return null;
  const encoded = url.pathname.replace(/^\//u, "");
  if (!encoded) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/** The label of the "show in the file manager" action on the platform of `userAgent`. */
export function revealLabel(userAgent: string): string {
  if (/Mac/u.test(userAgent)) return "Reveal in Finder";
  if (/Win/u.test(userAgent)) return "Show in Explorer";
  return "Show in file manager";
}

/** Natural size of an image at zoom 1; falls back to the size it is shown at (SVGs may have none). */
export function imageNaturalSize(img: {
  naturalWidth: number;
  naturalHeight: number;
  clientWidth: number;
  clientHeight: number;
}): { width: number; height: number } {
  if (img.naturalWidth > 0 && img.naturalHeight > 0)
    return { width: img.naturalWidth, height: img.naturalHeight };
  return { width: img.clientWidth || 300, height: img.clientHeight || 150 };
}

/**
 * Makes the images of `root` that are not inside a link reachable with the keyboard
 * (Tab to focus, Enter opens) and marks them for the zoom-in cursor.
 */
export function decorateImages(root: HTMLElement): void {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
    // A cover of a base is part of its card, which a click opens.
    if (img.closest(".mermaid-diagram, .base-block")) continue;
    if (img.closest("a")) {
      img.removeAttribute("data-zoomable");
      continue;
    }
    img.dataset["zoomable"] = "";
    img.tabIndex = 0;
    img.setAttribute("role", "button");
    if (!img.hasAttribute("aria-label"))
      img.setAttribute("aria-label", img.alt ? `Open image: ${img.alt}` : "Open image");
  }
}
