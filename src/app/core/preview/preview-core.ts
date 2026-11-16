/** Hover previews of links: when to show one, where to put it, and the cache of rendered notes. */

/** `modifier`: only with ⌘/Ctrl held (the default). `always`: on every hover. */
export type LinkPreviewMode = "modifier" | "always";

export function sanitizeMode(value: unknown): LinkPreviewMode {
  return value === "always" ? "always" : "modifier";
}

export function previewAllowed(mode: LinkPreviewMode, modifierHeld: boolean): boolean {
  return mode === "always" || modifierHeld;
}

/** The note part of a link target, without the display alias (`Note#Heading|Alias` → `Note#Heading`). */
export function targetOf(value: string): string {
  const pipe = value.indexOf("|");
  return (pipe >= 0 ? value.slice(0, pipe) : value).trim();
}

export interface Anchor {
  left: number;
  top: number;
  bottom: number;
}

export interface Placement {
  left: number;
  /** Distance from the top of the window; null when the popover sits above the anchor. */
  top: number | null;
  /** Distance from the bottom of the window; null when the popover sits below the anchor. */
  bottom: number | null;
}

const GAP = 4;
const MARGIN = 8;

/** Below the anchor when it fits, above it otherwise; kept inside the window horizontally. */
export function placePopover(
  anchor: Anchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - size.width - MARGIN));
  const fitsBelow = anchor.bottom + GAP + size.height <= viewport.height - MARGIN;
  const fitsAbove = anchor.top - GAP - size.height >= MARGIN;
  if (!fitsBelow && fitsAbove) return { left, top: null, bottom: viewport.height - anchor.top + GAP };
  return { left, top: anchor.bottom + GAP, bottom: null };
}

interface Entry {
  source: string;
  stamp: unknown;
  html: string;
}

/**
 * Rendered previews by key. An entry is only valid while the text of the note is unchanged (the
 * caller reads the note and passes it) and `stamp` (what else the HTML depends on) is the same object.
 */
export class PreviewCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly max = 100) {}

  get(key: string, source: string, stamp: unknown): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.source !== source || entry.stamp !== stamp) {
      this.entries.delete(key);
      return undefined;
    }
    // Most recently used last.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.html;
  }

  set(key: string, source: string, stamp: unknown, html: string): void {
    this.entries.delete(key);
    this.entries.set(key, { source, stamp, html });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
  }

  get size(): number {
    return this.entries.size;
  }
}
