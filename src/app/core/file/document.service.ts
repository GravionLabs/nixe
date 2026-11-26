import { Injectable, computed, signal } from "@angular/core";
import { open } from "@tauri-apps/plugin-dialog";

import { basename, toSlashes } from "../markdown/paths";
import { backend } from "./backend";

export const MARKDOWN_FILTER = {
  name: "Markdown",
  extensions: ["md", "markdown", "mdown", "mkd", "txt"],
};

/** Longest back/forward list of a tab; the oldest entries drop out. */
export const MAX_HISTORY = 200;

/** A stop of the back/forward list: a note and where the reader stood or was sent to in it. */
export interface HistoryEntry {
  path: string;
  /** 1-based source line (the top of the view when the entry was left). */
  line: number | null;
  /** Heading the jump went to; used while `line` is not known (the entry was never left). */
  anchor: string | null;
}

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

  private readonly history = signal<HistoryEntry[]>([]);
  private readonly historyIndex = signal(-1);
  readonly canGoBack = computed(() => this.historyIndex() > 0);
  readonly canGoForward = computed(() => this.historyIndex() < this.history().length - 1);

  /** Set by the tab: the 1-based line at the top of the view; null when it is not known. */
  positionHook: (() => number | null) | null = null;

  /** Set by the tab: scrolls an open editor to the line; false when no editor is shown. */
  revealHook: ((line: number) => boolean) | null = null;

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
    // The position of the note that is left is read before the new one replaces it.
    const left = addToHistory ? this.currentLine() : null;

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

    if (addToHistory) this.record({ path, line, anchor }, left);
  }

  /**
   * A jump within the open note (heading link, outline click): `scroll` moves the view and says
   * whether it did; then the jump becomes a history entry and the position left is stored.
   */
  jump(target: { anchor?: string | null; line?: number | null }, scroll: () => boolean): boolean {
    const path = this.path();
    const left = this.currentLine();
    if (!scroll()) return false;
    // The line the view landed on lets a second click on the same link tell whether the reader moved.
    const line = target.line ?? this.currentLine();
    if (path) this.record({ path, line, anchor: target.anchor ?? null }, left);
    return true;
  }

  private currentLine(): number | null {
    return this.positionHook?.() ?? null;
  }

  /** Adds `entry` after the current one (dropping the forward entries); `left` is where the reader was. */
  private record(entry: HistoryEntry, left: number | null): void {
    const list = this.history();
    const at = this.historyIndex();
    const current = list[at];
    if (current && current.path === entry.path) {
      // The same note without a target, or the target the reader already stands at: no entry.
      if (entry.anchor === null && entry.line === null) return;
      if (
        entry.anchor !== null &&
        current.anchor === entry.anchor &&
        (left === null || left === current.line)
      )
        return;
      if (entry.anchor === null && entry.line !== null && (left ?? current.line) === entry.line)
        return;
    }
    const kept = list.slice(0, at + 1);
    if (current && left !== null) kept[at] = { ...current, line: left };
    const next = [...kept, entry].slice(-MAX_HISTORY);
    this.history.set(next);
    this.historyIndex.set(next.length - 1);
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

  /**
   * Writes `text` and, when it is still the open note, makes it the content. With `expected` the
   * note is written only while the disk still holds it (`replace_text_file`).
   */
  async write(path: string, text: string, expected?: string): Promise<void> {
    if (expected === undefined) await backend.writeTextFile(path, text);
    else await backend.replaceTextFile(path, expected, text);
    if (this.path() === path) this.content.set(text);
    this.tabsHook?.wrote(this, path, text);
  }

  /** The back/forward list, for restoring the tab after a restart. */
  historyState(): { history: HistoryEntry[]; index: number } {
    return this.snapshot();
  }

  /**
   * Puts a stored back/forward list back; the shown note is not loaded. A path alone (the format
   * before positions) is an entry without a position.
   */
  restoreHistory(history: readonly (HistoryEntry | string)[], index: number): void {
    const entries = history
      .map((e) => (typeof e === "string" ? { path: e, line: null, anchor: null } : { ...e }))
      .slice(-MAX_HISTORY);
    const dropped = history.length - entries.length;
    this.history.set(entries);
    this.historyIndex.set(Math.min(Math.max(index - dropped, -1), entries.length - 1));
  }

  private snapshot(): { history: HistoryEntry[]; index: number } {
    const history = this.history().map((e) => ({ ...e }));
    const at = this.historyIndex();
    // The entry that is shown stores where the reader stands now, so a restart returns there.
    const line = this.currentLine();
    if (history[at] && line !== null && history[at].path === this.path())
      history[at] = { ...history[at], line };
    return { history, index: at };
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
    const entry = this.history()[index];
    if (!entry) return;
    const at = this.historyIndex();
    const left = this.currentLine();
    if (left !== null && this.history()[at]?.path === this.path()) {
      this.history.update((list) => list.map((e, i) => (i === at ? { ...e, line: left } : e)));
    }
    if (entry.path === this.path() && !this.missing()) {
      // Only the position differs: the view scrolls, the note is not read again.
      this.historyIndex.set(index);
      if (entry.line !== null) {
        if (!this.revealHook?.(entry.line)) this.pendingLine.set(entry.line);
      } else if (entry.anchor !== null) this.pendingAnchor.set(entry.anchor);
      return;
    }
    await this.open(entry.path, {
      addToHistory: false,
      anchor: entry.line === null ? entry.anchor : null,
      line: entry.line,
    });
    this.historyIndex.set(index);
  }
}
