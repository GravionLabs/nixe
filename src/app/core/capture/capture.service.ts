import { Injectable, computed, signal } from "@angular/core";

import { backend } from "../file/backend";
import type { WikilinkQuery } from "./capture-core";
import {
  applyCompletion,
  completeNames,
  insertAt,
  isUrl,
  markdownLink,
  wikilinkQueryAt,
} from "./capture-core";

/** How long the window stays open to show a notice of the link save. */
export const NOTICE_MS = 1500;

/** The state of the capture window (#118): the text, the `[[` completion, save and discard. */
@Injectable({ providedIn: "root" })
export class CaptureService {
  readonly text = signal("");
  readonly caret = signal(0);
  readonly error = signal<string | null>(null);
  readonly busy = signal(false);
  /** What the link save reports before the window closes: a duplicate or a failed fetch. */
  readonly notice = signal<string | null>(null);
  readonly names = signal<readonly string[]>([]);
  readonly selected = signal(0);
  /** Where the caret should go after the text changed through the service. */
  readonly pendingCaret = signal<number | null>(null);

  /** The text is one URL, so Alt+Enter can save it as a link note. */
  readonly isLink = computed(() => isUrl(this.text()));
  readonly link = computed<WikilinkQuery | null>(() => wikilinkQueryAt(this.text(), this.caret()));
  readonly suggestions = computed(() => {
    const link = this.link();
    return link ? completeNames(this.names(), link.query) : [];
  });

  /** Starts a fresh capture: empty text, the note names of the vault. */
  async reset(): Promise<void> {
    this.text.set("");
    this.caret.set(0);
    this.error.set(null);
    this.notice.set(null);
    this.busy.set(false);
    this.selected.set(0);
    try {
      this.names.set(await backend.captureNoteNames());
    } catch {
      this.names.set([]);
    }
  }

  edit(text: string, caret: number): void {
    this.text.set(text);
    this.caret.set(caret);
    this.selected.set(0);
  }

  moveSelection(delta: number): void {
    const count = this.suggestions().length;
    if (count > 0) this.selected.update((i) => (i + delta + count) % count);
  }

  /** Completes the open `[[` with a suggestion (the selected one by default). */
  complete(name = this.suggestions()[this.selected()]): boolean {
    const link = this.link();
    if (!link || name === undefined) return false;
    const next = applyCompletion(this.text(), this.caret(), link, name);
    this.edit(next.text, next.caret);
    this.pendingCaret.set(next.caret);
    return true;
  }

  /** Puts the clipboard at the selection; a URL becomes a link with the title of its page. */
  async insertClipboard(
    read: () => Promise<string | null>,
    start: number,
    end: number,
  ): Promise<void> {
    let clip: string | null;
    try {
      clip = await read();
    } catch {
      clip = null;
    }
    if (!clip) return;
    let insert = clip;
    if (isUrl(clip)) {
      const url = clip.trim();
      let title: string | null = null;
      try {
        title = await backend.captureLinkTitle(url);
      } catch {
        title = null;
      }
      insert = markdownLink(url, title);
    }
    const next = insertAt(this.text(), start, end, insert);
    this.edit(next.text, next.caret);
    this.pendingCaret.set(next.caret);
  }

  /** Writes the text and closes the window; an error stays in the window with the text. */
  async save(): Promise<boolean> {
    const text = this.text();
    if (!text.trim() || this.busy()) return false;
    this.busy.set(true);
    try {
      await backend.captureSave(text);
    } catch (err) {
      this.error.set(String(err));
      this.busy.set(false);
      return false;
    }
    await this.close();
    return true;
  }

  /**
   * Saves the URL as a link note (#507) and closes the window. A duplicate or a failed fetch
   * (the note is saved with the URL as title) shows its notice for `NOTICE_MS` first.
   */
  async saveLink(): Promise<boolean> {
    const text = this.text();
    if (!isUrl(text) || this.busy()) return false;
    this.busy.set(true);
    try {
      const saved = await backend.captureSaveLink(text.trim());
      const notice = !saved.created
        ? `already saved: ${saved.path}`
        : saved.warning
          ? `saved with the URL as title: ${saved.warning}`
          : null;
      if (notice) {
        this.notice.set(notice);
        await new Promise((resolve) => setTimeout(resolve, NOTICE_MS));
      }
    } catch (err) {
      this.error.set(String(err));
      this.busy.set(false);
      return false;
    }
    await this.close();
    return true;
  }

  /** Throws the text away and closes the window. */
  async discard(): Promise<void> {
    await this.close();
  }

  private async close(): Promise<void> {
    await backend.captureHide();
    await this.reset();
  }
}
