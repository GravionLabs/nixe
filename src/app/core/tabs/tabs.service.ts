import type { Provider, WritableSignal } from "@angular/core";
import {
  Injectable,
  InjectionToken,
  Injector,
  computed,
  inject,
  isSignal,
  signal,
} from "@angular/core";

import { EditorService } from "../editor/editor.service";
import { backend, type BaseSort } from "../file/backend";
import { DocumentService } from "../file/document.service";
import { OutlineService } from "../outline/outline.service";
import { SettingsService } from "../settings/settings.service";
import { isRemoteEpubUrl, toSlashes } from "../markdown/paths";
import type { CompareInput } from "../compare/compare";
import type { EpubBook } from "../epub/epub";
import { EpubService } from "../epub/epub.service";
import type { LayoutState, TabState, TabView } from "./layout";
import { TAB_VIEWS } from "./layout";
import { MAX_TABS, clampRatio } from "./layout";

/** What the viewer of a tab offers to the app. */
export interface ViewerHandle {
  topLine(): number | null;
  openFind(): void;
  fold(action: "fold" | "unfold" | "fold-all" | "unfold-all"): void;
}

/**
 * One note view. Every tab has its own document, editor and outline state (its own injector), so
 * back/forward history, scroll position and viewer/editor mode belong to the tab.
 */
export interface BaseChoice {
  /** The chosen view, by its place and name; null for the default one. */
  view: { index: number; name: string | null } | null;
  /** The sort of a clicked column header. */
  sort: BaseSort | null;
}

export interface Tab {
  readonly id: number;
  readonly injector: Injector;
  readonly doc: DocumentService;
  readonly editor: EditorService;
  readonly outline: OutlineService;
  /**
   * The view this tab shows instead of a note (settings, vault health); null for a note or an empty
   * tab. The tab keeps an empty document, so it never reaches the note history. Opening a note in
   * it turns it back into a note tab.
   */
  readonly view: WritableSignal<TabView | null>;
  /**
   * False for the preview tab (#416): the next preview open replaces its note. A tab is pinned when
   * it is created by the user (`+`, Ctrl+click, double click) and when it shows a view; an edit, a
   * save, moving the tab or a double click on its title pins a preview tab.
   */
  readonly pinned: WritableSignal<boolean>;
  /** What the compare view of this tab shows; set together with the view `compare`. */
  readonly compare: WritableSignal<CompareInput | null>;
  /** The book the epub view of this tab shows; set together with the view `epub` (#487). */
  readonly epub: WritableSignal<EpubBook | null>;
  /** The path of the `.base` file the base view of this tab shows; set with the view `base`. */
  readonly base: WritableSignal<string | null>;
  /** What was chosen in the base view of this tab; it is never written to the file. */
  readonly baseChoice: WritableSignal<BaseChoice>;
  /** Set by the pane while the viewer of the tab is shown. */
  viewer: ViewerHandle | null;
  /** 1-based first visible line, kept while the tab is not shown. */
  scrollLine: number | null;
}

export interface Pane {
  readonly id: number;
  readonly tabs: readonly Tab[];
  readonly activeId: number;
}

/** The tab a pane component belongs to; provided by the tab's injector. */
export const CURRENT_TAB = new InjectionToken<Tab>("CURRENT_TAB");

/**
 * A stand-in that always forwards to the object `read` returns now. Reading through it inside a
 * computed or an effect tracks the signals of `read`, so a consumer follows the focused tab.
 */
export function followActive<T extends object>(read: () => T): T {
  return new Proxy({} as T, {
    get(_, key) {
      const target = read();
      const value = Reflect.get(target, key, target);
      return typeof value === "function" && !isSignal(value) ? value.bind(target) : value;
    },
    set(_, key, value) {
      const target = read();
      return Reflect.set(target, key, value, target);
    },
    has(_, key) {
      return Reflect.has(read(), key);
    },
  });
}

/**
 * Makes the app-wide `DocumentService`, `EditorService` and `OutlineService` the ones of the
 * active tab of the focused pane (the panels and commands follow the focus). Only the app
 * registers these; the tab's own components get the tab's instances from its injector.
 */
export const ACTIVE_TAB_PROVIDERS: Provider[] = [
  { provide: DocumentService, useFactory: () => followTab((t) => t.doc) },
  { provide: EditorService, useFactory: () => followTab((t) => t.editor) },
  { provide: OutlineService, useFactory: () => followTab((t) => t.outline) },
];

function followTab<T extends object>(pick: (tab: Tab) => T): T {
  const tabs = inject(TabsService);
  return followActive(() => pick(tabs.activeTab()));
}

/** Tabs in one or two panes (the second one to the right). */
@Injectable({ providedIn: "root" })
export class TabsService {
  private readonly injector = inject(Injector);
  /** Looked up when a note opens: the tabs of most tests need no settings. */
  private get settings(): SettingsService {
    return this.injector.get(SettingsService);
  }
  private nextId = 1;

  readonly panes = signal<readonly Pane[]>([]);
  readonly focusedId = signal(0);
  /** Share of the width the first pane takes while split. */
  readonly ratio = signal(0.5);
  /** A message for the user, from a pane that has no way to show it itself. */
  readonly notice = signal<string | null>(null);

  readonly focusedPane = computed(() => {
    const panes = this.panes();
    return panes.find((p) => p.id === this.focusedId()) ?? panes[0];
  });
  /** The tab of the focused pane that is shown. */
  readonly activeTab = computed(() => {
    const pane = this.focusedPane();
    return pane.tabs.find((t) => t.id === pane.activeId) ?? pane.tabs[0];
  });
  readonly split = computed(() => this.panes().length > 1);
  /** False while there is only one empty tab: the welcome page is shown then. */
  readonly showWorkspace = computed(() => {
    const panes = this.panes();
    return (
      panes.length > 1 ||
      panes[0].tabs.length > 1 ||
      this.activeTab().doc.path() !== null ||
      this.activeTab().view() !== null
    );
  });

  private readonly hook = {
    typed: (source: DocumentService, path: string, text: string) => {
      this.pinOf(source);
      this.sync(source, path, text, false);
    },
    wrote: (source: DocumentService, path: string, text: string) => {
      this.pinOf(source);
      this.sync(source, path, text, true);
    },
  };

  constructor() {
    this.reset();
  }

  /** Closes everything and starts with one empty tab. */
  reset(): void {
    const tab = this.createTab(false);
    const id = this.nextId++;
    this.panes.set([{ id, tabs: [tab], activeId: tab.id }]);
    this.focusedId.set(id);
    this.ratio.set(0.5);
  }

  /** A new empty tab in the focused pane, shown at once. */
  newTab(): Tab {
    return this.addTab(this.focusedPane(), true);
  }

  private addTab(pane: Pane, pinned: boolean): Tab {
    if (pane.tabs.length >= MAX_TABS) throw new Error(`At most ${MAX_TABS} tabs can be open.`);
    const tab = this.createTab(pinned);
    this.leave(this.shownTab(pane));
    this.updatePane(pane.id, (p) => ({ ...p, tabs: [...p.tabs, tab], activeId: tab.id }));
    this.watch();
    return tab;
  }

  /** Shows a view as a tab: the one that exists (in either pane) is focused, else a new tab opens. */
  openView(view: TabView): Tab {
    for (const pane of this.panes()) {
      const found = pane.tabs.find((t) => t.view() === view);
      if (found) {
        this.activate(pane.id, found.id);
        return found;
      }
    }
    const tab = this.newTab();
    tab.view.set(view);
    return tab;
  }

  /**
   * Opens the EPUB book at `path` in a reader tab; the tab that reads it already is focused. The
   * book is read first, so a book that cannot be read opens no tab and the error reaches the caller.
   */
  async openEpub(path: string): Promise<Tab> {
    // A link to a book on the web: the core downloads it once and the tab shows the local file.
    if (isRemoteEpubUrl(path)) path = await backend.downloadEpub(path);
    path = toSlashes(path);
    const find = () =>
      this.allTabs().find((t) => t.view() === "epub" && t.epub()?.path === path) ?? null;
    const open = (tab: Tab) => {
      const pane = this.panes().find((p) => p.tabs.includes(tab));
      if (pane) this.activate(pane.id, tab.id);
      return tab;
    };
    const known = find();
    if (known) return open(known);
    const book = await this.injector.get(EpubService).load(path);
    // The same book may have been opened while this one was read.
    const again = find();
    if (again) return open(again);
    const tab = this.newTab();
    tab.epub.set(book);
    tab.view.set("epub");
    return tab;
  }

  /** Opens the `.base` file at `path` in a table tab; the tab that shows it already is focused. */
  openBase(path: string): Tab {
    path = toSlashes(path);
    for (const pane of this.panes()) {
      const found = pane.tabs.find((t) => t.view() === "base" && t.base() === path);
      if (found) {
        this.activate(pane.id, found.id);
        return found;
      }
    }
    const tab = this.newTab();
    tab.base.set(path);
    tab.view.set("base");
    return tab;
  }

  /** Moves a tab of a pane to position `to` (the position it has after the move). */
  moveTab(paneId: number, from: number, to: number): void {
    const pane = this.panes().find((p) => p.id === paneId);
    if (
      !pane ||
      from === to ||
      from < 0 ||
      from >= pane.tabs.length ||
      to < 0 ||
      to >= pane.tabs.length
    )
      return;
    const tabs = [...pane.tabs];
    const [tab] = tabs.splice(from, 1);
    tabs.splice(to, 0, tab);
    tab.pinned.set(true);
    this.updatePane(paneId, (p) => ({ ...p, tabs }));
  }

  /** Moves a tab from one pane into another, at `index`, and shows it there. */
  moveTabToPane(fromPaneId: number, tabId: number, toPaneId: number, index: number): void {
    if (fromPaneId === toPaneId) return;
    const panes = this.panes();
    const from = panes.find((p) => p.id === fromPaneId);
    const to = panes.find((p) => p.id === toPaneId);
    const tab = from?.tabs.find((t) => t.id === tabId);
    if (!from || !to || !tab || to.tabs.length >= MAX_TABS) return;
    this.leave(this.shownTab(to));
    tab.pinned.set(true);
    const at = Math.min(Math.max(index, 0), to.tabs.length);
    const rest = from.tabs.filter((t) => t.id !== tabId);
    const next = panes
      .map((p) => {
        if (p.id === toPaneId)
          return {
            ...p,
            tabs: [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)],
            activeId: tab.id,
          };
        if (p.id !== fromPaneId) return p;
        const wasShown = p.activeId === tabId;
        return {
          ...p,
          tabs: rest,
          activeId:
            wasShown && rest.length
              ? rest[Math.min(from.tabs.indexOf(tab), rest.length - 1)].id
              : p.activeId,
        };
      })
      .filter((p) => p.tabs.length > 0);
    this.panes.set(next);
    this.focusedId.set(toPaneId);
    this.watch();
  }

  /** Opens a note in a new tab of the focused pane; the tab is dropped again when it fails. */
  async openInNewTab(
    path: string,
    options: Parameters<DocumentService["open"]>[1] = {},
  ): Promise<void> {
    const paneId = this.focusedPane().id;
    const tab = this.newTab();
    try {
      await tab.doc.open(path, options);
    } catch (err) {
      this.closeTab(paneId, tab.id);
      throw err;
    }
  }

  /** True for a tab that the next preview open replaces (a note, not a view, not pinned). */
  isPreview(tab: Tab): boolean {
    return !tab.pinned() && tab.doc.path() !== null && tab.view() === null;
  }

  /**
   * A single click on a note (#416): it shows in the preview tab of the focused pane, which it
   * replaces or which is added; a pinned tab that shows the note is focused instead. With the
   * setting off, the note opens in the shown tab as before.
   */
  openPreview(path: string, options: Parameters<DocumentService["open"]>[1] = {}): Promise<void> {
    path = toSlashes(path);
    const run = this.previewOpen(path, options);
    const entry = { path, run };
    this.opening = entry;
    const clear = () => {
      if (this.opening === entry) this.opening = null;
    };
    run.then(clear, clear);
    return run;
  }

  /** The preview open that is still reading its note: a double click waits for it to find the tab. */
  private opening: { path: string; run: Promise<void> } | null = null;

  private async previewOpen(
    path: string,
    options: Parameters<DocumentService["open"]>[1],
  ): Promise<void> {
    if (!this.settings.previewTabs()) {
      await this.openHere(this.activeTab(), path, options);
      return;
    }
    const pinned = this.findPinned(path);
    if (pinned) {
      this.activate(pinned.paneId, pinned.tab.id);
      await this.openHere(pinned.tab, path, options);
      return;
    }
    const pane = this.focusedPane();
    // The shown tab takes the note when it is empty (also a new tab); else the preview tab does.
    const shown = this.shownTab(pane);
    const slot =
      shown.doc.path() === null && shown.view() === null
        ? shown
        : pane.tabs.find((t) => this.isPreview(t) && !t.editor.unsaved());
    if (slot) {
      this.activate(pane.id, slot.id);
      await this.openHere(slot, path, options);
      return;
    }
    // Every other tab keeps its note: the preview is a tab of its own.
    const fresh = this.addTab(pane, false);
    try {
      await fresh.doc.open(path, options);
    } catch (err) {
      this.closeTab(pane.id, fresh.id);
      throw err;
    }
  }

  /**
   * A double click on a note (#416): the note stays in a tab of its own. The preview tab that shows
   * it turns pinned; a pinned tab that shows it is focused; else a new pinned tab opens.
   */
  async openPinned(
    path: string,
    options: Parameters<DocumentService["open"]>[1] = {},
  ): Promise<void> {
    path = toSlashes(path);
    if (this.opening?.path === path) await this.opening.run.catch(() => undefined);
    if (!this.settings.previewTabs()) {
      await this.openHere(this.activeTab(), path, options);
      return;
    }
    const shown = this.focusedPane().tabs.find((t) => this.isPreview(t) && t.doc.path() === path);
    if (shown) {
      shown.pinned.set(true);
      this.activate(this.focusedPane().id, shown.id);
      return;
    }
    const pinned = this.findPinned(path);
    if (pinned) {
      this.activate(pinned.paneId, pinned.tab.id);
      return;
    }
    await this.openInNewTab(path, options);
  }

  /** Keeps the preview tab (default: the shown one) open. Does nothing while previews are off. */
  keepOpen(tabId?: number, paneId: number = this.focusedPane().id): void {
    if (!this.settings.previewTabs()) return;
    const pane = this.panes().find((p) => p.id === paneId);
    const tab = pane?.tabs.find((t) => t.id === (tabId ?? pane.activeId));
    tab?.pinned.set(true);
  }

  /** Opens `path` in `tab`; a note that it shows already is not read again without a target. */
  private async openHere(
    tab: Tab,
    path: string,
    options: Parameters<DocumentService["open"]>[1],
  ): Promise<void> {
    const { anchor = null, line = null } = options ?? {};
    if (tab.doc.path() === path && tab.view() === null && anchor === null && line === null) return;
    await tab.doc.open(path, options);
  }

  private findPinned(path: string): { paneId: number; tab: Tab } | null {
    const panes = this.panes();
    const focused = this.focusedPane();
    for (const pane of [focused, ...panes.filter((p) => p.id !== focused.id)]) {
      const tab = pane.tabs.find((t) => t.pinned() && t.view() === null && t.doc.path() === path);
      if (tab) return { paneId: pane.id, tab };
    }
    return null;
  }

  /** The typing or the saving of a tab keeps it open. */
  private pinOf(doc: DocumentService): void {
    for (const tab of this.allTabs()) if (tab.doc === doc) tab.pinned.set(true);
  }

  /**
   * Closes a tab (default: the shown one). The last tab of the second pane takes the pane with it;
   * the last tab of all stays as an empty one. Returns false when there was nothing to close
   * (a single empty tab).
   */
  closeTab(paneId: number = this.focusedPane().id, tabId?: number): boolean {
    const panes = this.panes();
    const pane = panes.find((p) => p.id === paneId);
    if (!pane) return false;
    const id = tabId ?? pane.activeId;
    const at = pane.tabs.findIndex((t) => t.id === id);
    if (at < 0) return false;
    const closing = pane.tabs[at];

    if (pane.tabs.length === 1) {
      if (panes.length > 1) {
        const rest = panes.filter((p) => p.id !== paneId);
        this.panes.set(rest);
        this.focusedId.set(rest[0].id);
        this.watch();
        return true;
      }
      if (closing.doc.path() === null && closing.view() === null) return false;
      const fresh = this.createTab(false);
      this.panes.set([{ ...pane, tabs: [fresh], activeId: fresh.id }]);
      this.watch();
      return true;
    }

    const tabs = pane.tabs.filter((t) => t.id !== id);
    const activeId = id === pane.activeId ? tabs[Math.min(at, tabs.length - 1)].id : pane.activeId;
    this.updatePane(paneId, (p) => ({ ...p, tabs, activeId }));
    this.watch();
    return true;
  }

  /** Shows a tab and focuses its pane. */
  activate(paneId: number, tabId: number): void {
    const pane = this.panes().find((p) => p.id === paneId);
    if (!pane || !pane.tabs.some((t) => t.id === tabId)) return;
    if (pane.activeId !== tabId) {
      this.leave(this.shownTab(pane));
      this.updatePane(paneId, (p) => ({ ...p, activeId: tabId }));
    }
    this.focusPane(paneId);
    this.watch();
  }

  focusPane(paneId: number): void {
    if (this.focusedId() === paneId || !this.panes().some((p) => p.id === paneId)) return;
    this.focusedId.set(paneId);
    this.watch();
  }

  /** The other pane gets the focus (the first one when there is only one). */
  focusNextPane(): void {
    const panes = this.panes();
    const at = panes.findIndex((p) => p.id === this.focusedPane().id);
    this.focusPane(panes[(at + 1) % panes.length].id);
  }

  /** Shows the next (`1`) or previous (`-1`) tab of the focused pane, wrapping around. */
  cycle(delta: 1 | -1): void {
    const pane = this.focusedPane();
    if (pane.tabs.length < 2) return;
    const at = pane.tabs.findIndex((t) => t.id === pane.activeId);
    this.activate(pane.id, pane.tabs[(at + delta + pane.tabs.length) % pane.tabs.length].id);
  }

  /**
   * Shows a copy of the shown tab in the right pane (created when needed): same note, same mode,
   * its own history. Both views stay in sync while typing.
   */
  async splitRight(): Promise<void> {
    const source = this.activeTab();
    // Typed text reaches the disk first, so the copy starts from it.
    await source.editor.handle?.flush();
    const copy = this.createTab();
    const path = source.doc.path();
    if (path) {
      await copy.doc.open(path, { addToHistory: false, watch: false });
      const { history, index } = source.doc.historyState();
      copy.doc.restoreHistory(history, index);
      const line = this.lineOf(source);
      copy.editor.copyModeFrom(source.editor);
      if (source.editor.editing()) {
        copy.editor.startLine.set(line);
        copy.editor.editing.set(true);
      } else {
        copy.doc.pendingLine.set(line);
      }
      copy.scrollLine = line;
    }
    const panes = this.panes();
    if (panes.length < 2) {
      const id = this.nextId++;
      this.panes.set([...panes, { id, tabs: [copy], activeId: copy.id }]);
      this.focusedId.set(id);
    } else {
      const right = panes[1];
      this.leave(this.shownTab(right));
      this.updatePane(right.id, (p) => ({ ...p, tabs: [...p.tabs, copy], activeId: copy.id }));
      this.focusedId.set(right.id);
    }
    this.watch();
  }

  /** Merges the right pane's tabs into the first pane. */
  unsplit(): void {
    const panes = this.panes();
    if (panes.length < 2) return;
    const [left, right] = panes;
    // At most one preview tab per pane.
    if (left.tabs.some((t) => this.isPreview(t))) for (const t of right.tabs) t.pinned.set(true);
    const activeId = this.focusedPane().id === right.id ? right.activeId : left.activeId;
    if (activeId !== left.activeId) this.leave(this.shownTab(left));
    this.panes.set([{ ...left, tabs: [...left.tabs, ...right.tabs], activeId }]);
    this.focusedId.set(left.id);
    this.watch();
  }

  setRatio(ratio: number): void {
    this.ratio.set(clampRatio(ratio));
  }

  /** The watcher reported a change of `path`: every tab showing it takes the change. */
  async onExternalChange(path: string): Promise<void> {
    const tabs = this.allTabs().filter((t) => t.doc.path() === toSlashes(path));
    await Promise.all(tabs.map((t) => t.doc.onExternalChange(path)));
  }

  /** The tabs and the split, as stored per vault. */
  snapshot(): LayoutState {
    const panes = this.panes();
    return {
      panes: panes.map((pane) => ({
        tabs: pane.tabs.map((tab) => this.tabState(tab)),
        active: Math.max(
          0,
          pane.tabs.findIndex((t) => t.id === pane.activeId),
        ),
      })),
      focused: Math.max(
        0,
        panes.findIndex((p) => p.id === this.focusedPane().id),
      ),
      ratio: this.ratio(),
    };
  }

  /**
   * Opens the tabs of a stored layout. Notes that cannot be read are left out; false when no tab
   * with a note is left (the layout is not applied then).
   */
  async restore(layout: LayoutState): Promise<boolean> {
    const built = await Promise.all(
      layout.panes.map(async (pane) => {
        const tabs = await Promise.all(pane.tabs.map((state) => this.restoreTab(state)));
        const kept = tabs.map((tab, i) => ({ tab, i })).filter((x) => x.tab !== null) as {
          tab: Tab;
          i: number;
        }[];
        return { pane, kept };
      }),
    );
    if (!built.some((b) => b.kept.some((k) => k.tab.doc.path() !== null || k.tab.view() !== null)))
      return false;
    const panes: Pane[] = [];
    let focused = -1;
    built.forEach((b, i) => {
      if (b.kept.length === 0) return;
      const shown = b.kept.find((k) => k.i === b.pane.active) ?? b.kept[0];
      const id = this.nextId++;
      // At most one preview tab per pane: the first one stays, the others are pinned.
      let preview = false;
      for (const k of b.kept) {
        const wanted = b.pane.tabs[k.i].preview && k.tab.doc.path() !== null;
        k.tab.pinned.set(!wanted || preview);
        preview ||= wanted;
      }
      panes.push({ id, tabs: b.kept.map((k) => k.tab), activeId: shown.tab.id });
      if (i === layout.focused) focused = panes.length - 1;
    });
    this.panes.set(panes);
    this.focusedId.set(panes[Math.max(focused, 0)].id);
    this.ratio.set(clampRatio(layout.ratio));
    this.watch();
    return true;
  }

  private async restoreTab(state: TabState): Promise<Tab | null> {
    const tab = this.createTab();
    if (state.view !== null) {
      tab.view.set(state.view);
      return tab;
    }
    if (state.path === null) return tab;
    try {
      await tab.doc.open(state.path, { addToHistory: false, watch: false });
    } catch {
      return null;
    }
    const path = tab.doc.path()!;
    const usable = state.history.length > 0 && state.history[state.index]?.path === path;
    tab.doc.restoreHistory(
      usable ? state.history : [{ path, line: null, anchor: null }],
      usable ? state.index : 0,
    );
    tab.scrollLine = state.line;
    if (state.editing && (await backend.isUtf8File(path).catch(() => false))) {
      tab.editor.startLine.set(state.line);
      tab.editor.applyMode("live");
      tab.editor.editing.set(true);
    } else {
      tab.doc.pendingLine.set(state.line);
    }
    return tab;
  }

  private tabState(tab: Tab): TabState {
    const path = tab.doc.path();
    const { history, index } = tab.doc.historyState();
    const view = tab.view();
    return {
      // A compare view has no stored form: the tab comes back empty.
      view: TAB_VIEWS.find((v) => v === view) ?? null,
      path,
      history,
      index,
      editing: path !== null && tab.editor.editing(),
      line: this.lineOf(tab),
      preview: path !== null && view === null && !tab.pinned(),
    };
  }

  private lineOf(tab: Tab): number | null {
    return (
      tab.viewer?.topLine() ??
      tab.editor.handle?.topLine() ??
      tab.scrollLine ??
      tab.doc.pendingLine()
    );
  }

  /** Remembers where the tab is scrolled to, so it comes back there when it is shown again. */
  private leave(tab: Tab): void {
    const line = tab.viewer?.topLine() ?? tab.editor.handle?.topLine() ?? null;
    if (line === null) return;
    tab.scrollLine = line;
    if (tab.editor.editing()) tab.editor.startLine.set(line);
    else tab.doc.pendingLine.set(line);
  }

  private shownTab(pane: Pane): Tab {
    return pane.tabs.find((t) => t.id === pane.activeId) ?? pane.tabs[0];
  }

  private allTabs(): Tab[] {
    return this.panes().flatMap((p) => [...p.tabs]);
  }

  private updatePane(id: number, change: (pane: Pane) => Pane): void {
    this.panes.update((panes) => panes.map((p) => (p.id === id ? change(p) : p)));
  }

  /** Only one file is watched: the note of the shown tab of the focused pane. */
  private watch(): void {
    const path = this.activeTab().doc.path();
    if (path) backend.watchFile(path).catch(() => undefined);
    // Only the watched note reports a deletion: look at the others when the focus moves.
    for (const tab of this.allTabs()) void tab.doc.checkMissing();
  }

  /** Typing or saving in one tab reaches the other tabs showing the same note. */
  private sync(source: DocumentService, path: string, text: string, saved: boolean): void {
    for (const tab of this.allTabs()) if (tab.doc !== source) tab.doc.remote(path, text, saved);
  }

  private createTab(pinned = true): Tab {
    const holder: { tab?: Tab } = {};
    const injector = Injector.create({
      parent: this.injector,
      providers: [
        { provide: DocumentService, useClass: DocumentService, deps: [] },
        { provide: EditorService, useClass: EditorService, deps: [] },
        { provide: OutlineService, useClass: OutlineService, deps: [] },
        { provide: CURRENT_TAB, useFactory: () => holder.tab, deps: [] },
      ],
    });
    const doc = injector.get(DocumentService);
    doc.tabsHook = this.hook;
    const tab: Tab = {
      id: this.nextId++,
      injector,
      doc,
      editor: injector.get(EditorService),
      outline: injector.get(OutlineService),
      view: signal<TabView | null>(null),
      pinned: signal(pinned),
      compare: signal<CompareInput | null>(null),
      epub: signal<EpubBook | null>(null),
      base: signal<string | null>(null),
      baseChoice: signal<BaseChoice>({ view: null, sort: null }),
      viewer: null,
      scrollLine: null,
    };
    holder.tab = tab;
    doc.positionHook = () => tab.viewer?.topLine() ?? tab.editor.handle?.topLine() ?? null;
    doc.revealHook = (line) => {
      const handle = tab.editor.editing() ? tab.editor.handle : null;
      if (!handle) return false;
      handle.scrollToLine(line);
      return true;
    };
    return tab;
  }
}
