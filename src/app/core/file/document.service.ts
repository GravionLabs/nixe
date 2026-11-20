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
  /** The file was deleted or moved outside Nixe; cleared when it returns. */
  readonly missing = signal(false);
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
    options: {
      anchor?: string | null;
      line?: number | null;
      addToHistory?: boolean;
      watch?: boolean;
    } = {},
  ): Promise<void> {
    const { anchor = null, line = null, addToHistory = true, watch = true } = options;
    path = toSlashes(path);

    const [text, wikiRoot] = await Promise.all([
      backend.readTextFile(path),
      backend.findWikiRoot(path),
    ]);
    this.wikiRoot.set(toSlashes(wikiRoot));
    this.path.set(path);
    this.content.set(text);
    this.missing.set(false);
    this.pendingAnchor.set(anchor);
    this.pendingLine.set(line);
    if (watch) await backend.watchFile(path);

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
    this.missing.set(false);
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

  /** Set by the tabs: tells the other tabs that show the same note about typing and saving. */
  tabsHook: {
    typed(source: DocumentService, path: string, text: string): void;
    wrote(source: DocumentService, path: string, text: string): void;
  } | null = null;

  /** Set by the open editor: takes text that another tab typed or saved (`saved`: it is on disk). */
  remoteHook: ((text: string, saved: boolean) => void) | null = null;

  /** The editor's text changed while typing; the other tabs on this note follow it. */
  typed(path: string, text: string): void {
    this.tabsHook?.typed(this, path, text);
  }

  /** Text of this note from another tab: becomes the content and reaches an open editor. */
  remote(path: string, text: string, saved: boolean): void {
    if (this.path() !== path) return;
    this.content.set(text);
    this.remoteHook?.(text, saved);
  }

  /** Writes `text` and, when it is still the open note, makes it the content. */
  async write(path: string, text: string): Promise<void> {
    await backend.writeTextFile(path, text);
    if (this.path() === path) this.content.set(text);
    this.tabsHook?.wrote(this, path, text);
  }

  /** The back/forward list, for restoring the tab after a restart. */
  historyState(): { history: string[]; index: number } {
    return { history: [...this.history()], index: this.historyIndex() };
  }

  /** Puts a stored back/forward list back; the shown note is not loaded. */
  restoreHistory(history: readonly string[], index: number): void {
    this.history.set([...history]);
    this.historyIndex.set(Math.min(Math.max(index, -1), history.length - 1));
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

  /** Looks whether the file is still there: the watcher only follows one note at a time. */
  async checkMissing(): Promise<void> {
    const path = this.path();
    if (!path) return;
    const exists = await backend.pathExists(path).catch(() => true);
    if (this.path() === path) this.missing.set(!exists);
  }

  /** Called by the file watcher. */
  async onExternalChange(path: string): Promise<void> {
    if (toSlashes(path) !== this.path()) return;
    let text: string;
    try {
      text = await backend.readTextFile(path);
    } catch {
      // Gone (deleted or moved) or being replaced: only a file that is not there is missing.
      if (!(await backend.pathExists(path).catch(() => true))) this.missing.set(true);
      return;
    }
    this.missing.set(false);
    if (this.editorHook) this.editorHook(toSlashes(path), text);
    else this.content.set(text);
  }

  private async goTo(index: number): Promise<void> {
    const path = this.history()[index];
    if (!path) return;
    await this.open(path, { addToHistory: false });
    this.historyIndex.set(index);
  }
}
