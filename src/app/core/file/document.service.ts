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
    options: { anchor?: string | null; addToHistory?: boolean } = {},
  ): Promise<void> {
    const { anchor = null, addToHistory = true } = options;
    path = toSlashes(path);

    const [text, wikiRoot] = await Promise.all([
      backend.readTextFile(path),
      backend.findWikiRoot(path),
    ]);
    this.wikiRoot.set(toSlashes(wikiRoot));
    this.path.set(path);
    this.content.set(text);
    this.pendingAnchor.set(anchor);
    await backend.watchFile(path);

    if (addToHistory && this.history()[this.historyIndex()] !== path) {
      const next = [...this.history().slice(0, this.historyIndex() + 1), path];
      this.history.set(next);
      this.historyIndex.set(next.length - 1);
    }
  }

  async openWithDialog(): Promise<void> {
    const selected = await open({ multiple: false, directory: false, filters: [MARKDOWN_FILTER] });
    if (typeof selected === "string") await this.open(selected);
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
      this.content.set(await backend.readTextFile(path));
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
