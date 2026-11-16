import { Injectable, computed, signal } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";

import { basename, toSlashes } from "../markdown/paths";
import { backend } from "./backend";

export const MARKDOWN_FILTER = {
  name: "Markdown",
  extensions: ["md", "markdown", "mdown", "mkd", "txt"],
};

/** The displayed document: path, content and navigation history. */
@Injectable({ providedIn: "root" })
export class DocumentService {
  readonly path = signal<string | null>(null);
  readonly wikiRoot = signal<string | null>(null);
  readonly content = signal("");
  /** Heading to scroll to once the next document is rendered. */
  readonly pendingAnchor = signal<string | null>(null);
  /** 1-based source line to scroll to once the next document is rendered. */
  readonly pendingLine = signal<number | null>(null);

  readonly fileName = computed(() => {
    const p = this.path();
    return p ? basename(p) : null;
  });

  private readonly history = signal<string[]>([]);
  private readonly historyIndex = signal(-1);
  readonly canGoBack = computed(() => this.historyIndex() > 0);
  readonly canGoForward = computed(() => this.historyIndex() < this.history().length - 1);

  async open(
    path: string,
    options: { anchor?: string | null; line?: number | null; addToHistory?: boolean } = {},
  ): Promise<void> {
    const { anchor = null, line = null, addToHistory = true } = options;
    path = toSlashes(path);

    const [text, wikiRoot] = await Promise.all([
      backend.readTextFile(path),
      backend.findWikiRoot(path),
    ]);
    this.wikiRoot.set(toSlashes(wikiRoot));
    this.path.set(path);
    this.content.set(text);
    this.pendingAnchor.set(anchor);
    this.pendingLine.set(line);
    await backend.watchFile(path);

    if (addToHistory && this.history()[this.historyIndex()] !== path) {
      const next = [...this.history().slice(0, this.historyIndex() + 1), path];
      this.history.set(next);
      this.historyIndex.set(next.length - 1);
    }
  }

  /** Shows no note (the open one was deleted). */
  close(): void {
    this.path.set(null);
    this.wikiRoot.set(null);
    this.content.set("");
    this.pendingAnchor.set(null);
    this.pendingLine.set(null);
  }

  async openWithDialog(): Promise<void> {
    const selected = await open({ multiple: false, directory: false, filters: [MARKDOWN_FILTER] });
    if (typeof selected === "string") await this.open(selected);
  }

  /**
   * Set while the editor is open: external changes go to it instead of `content`, so the
   * editor can ask before it replaces unsaved text.
   */
  editorHook: ((path: string, diskText: string) => void) | null = null;

  /** Writes `text` and, when it is still the open note, makes it the content. */
  async write(path: string, text: string): Promise<void> {
    await backend.writeTextFile(path, text);
    if (this.path() === path) this.content.set(text);
  }

  async reload(): Promise<void> {
    const path = this.path();
    if (path) this.content.set(await backend.readTextFile(path));
  }

  async back(): Promise<void> {
    await this.goTo(this.historyIndex() - 1);
  }

  async forward(): Promise<void> {
    await this.goTo(this.historyIndex() + 1);
  }

  /** Called by the file watcher. */
  async onExternalChange(path: string): Promise<void> {
    if (toSlashes(path) !== this.path()) return;
    try {
      const text = await backend.readTextFile(path);
      if (this.editorHook) this.editorHook(toSlashes(path), text);
      else this.content.set(text);
    } catch {
      // file is being replaced – the next event will pick it up
    }
  }

  private async goTo(index: number): Promise<void> {
    const path = this.history()[index];
    if (!path) return;
    await this.open(path, { addToHistory: false });
    this.historyIndex.set(index);
  }
}
