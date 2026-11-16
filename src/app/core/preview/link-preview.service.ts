import { Injectable, inject, signal } from "@angular/core";

import { backend } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { notePart } from "../markdown/embed";
import { MarkdownService, RenderContext } from "../markdown/markdown.service";
import { isMarkdownPath, joinPath } from "../markdown/paths";
import { parseWikilinkTarget, resolveWikilink } from "../markdown/wikilink-resolver";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { Anchor, PreviewCache, previewAllowed } from "./preview-core";

export const PREVIEW_DELAY_MS = 350;
export const PREVIEW_HIDE_MS = 250;

export interface ShownPreview {
  /** Sanitized HTML of the previewed part. */
  html: string;
  /** Link target it was made for. */
  target: string;
  /** Absolute path of the note, for relative links and images inside it. */
  path: string;
  anchor: Anchor;
}

/**
 * The hover popover of links. Sources (viewer, editor, backlinks panel) call `hover` and `leave`;
 * the popover component shows `shown`. The popover itself never takes the focus.
 */
@Injectable({ providedIn: "root" })
export class LinkPreviewService {
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly markdown = inject(MarkdownService);
  private readonly cache = new PreviewCache();

  readonly shown = signal<ShownPreview | null>(null);

  private showTimer: ReturnType<typeof setTimeout> | undefined;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the pointer is on (pending or shown); null when on nothing. */
  private key: string | null = null;
  private seq = 0;

  /** The pointer is on a link to `target`. `modifier`: ⌘/Ctrl is held. */
  hover(target: string, anchor: Anchor, modifier: boolean): void {
    const key = `${target}@${Math.round(anchor.left)},${Math.round(anchor.top)}`;
    if (key === this.key) {
      this.cancelHide();
      return;
    }
    if (!previewAllowed(this.settings.linkPreview(), modifier)) {
      // Not wanted here (no modifier): nothing opens, and the popover of another link closes.
      clearTimeout(this.showTimer);
      this.key = null;
      this.leave();
      return;
    }
    this.cancelHide();
    this.key = key;
    clearTimeout(this.showTimer);
    this.showTimer = setTimeout(() => void this.load(target, anchor, key), PREVIEW_DELAY_MS);
  }

  /** The pointer left the link or the popover. The popover closes shortly, unless the pointer is back. */
  leave(): void {
    clearTimeout(this.showTimer);
    this.seq++; // a render in progress is dropped
    this.cancelHide();
    this.hideTimer = setTimeout(() => this.close(), PREVIEW_HIDE_MS);
  }

  /** The pointer is on the popover. */
  keep(): void {
    this.cancelHide();
  }

  close(): void {
    clearTimeout(this.showTimer);
    this.cancelHide();
    this.seq++;
    this.key = null;
    this.shown.set(null);
  }

  /** Renders the part of the note `target` names, from the cache when the note is unchanged. */
  async render(target: string): Promise<{ html: string; path: string } | null> {
    const root = this.workspace.vaultRoot();
    const files = this.workspace.vaultFiles();
    if (!root || !files) return null;
    const { note } = parseWikilinkTarget(target);
    const rel = note ? resolveWikilink(target, files) : null;
    if (!rel || !isMarkdownPath(rel)) return null;
    const path = joinPath(root, rel);
    let text: string;
    try {
      text = await backend.readTextFile(path);
    } catch {
      return null;
    }
    const math = this.settings.math();
    const key = `${path}\0${target.slice(note.length)}\0${math}`;
    const cached = this.cache.get(key, text, files);
    if (cached !== undefined) return { html: cached, path };
    const part = notePart(text, target);
    if (part === null) return null;
    const ctx: RenderContext = {
      filePath: path,
      wikiRoot: this.doc.wikiRoot(),
      math,
      vaultFiles: files,
      vaultRoot: root,
    };
    const html = this.markdown.render(part.text, ctx);
    this.cache.set(key, text, files, html);
    return { html, path };
  }

  private async load(target: string, anchor: Anchor, key: string): Promise<void> {
    const seq = ++this.seq;
    const rendered = await this.render(target).catch(() => null);
    if (seq !== this.seq || key !== this.key || !rendered) return;
    this.shown.set({ html: rendered.html, target, path: rendered.path, anchor });
  }

  private cancelHide(): void {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }
}
