import { CaptureShortcutService } from "./core/capture/capture-shortcut.service";
import {
  Component,
  Directive,
  TemplateRef,
  computed,
  effect,
  inject,
  input,
  isDevMode,
  signal,
  untracked,
  viewChildren,
} from "@angular/core";
import { HxActivityBar, HxAppShell } from "@gravionlabs/helix-desktop";
import { HxMessageService, HxToast } from "@gravionlabs/helix-ui";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  FILE_CHANGED_EVENT,
  MENU_EVENT,
  OPEN_FILE_EVENT,
  STDIN_FILE_SUFFIX,
  backend,
} from "./core/file/backend";
import { EditorService } from "./core/editor/editor.service";
import type { Command } from "./core/commands/command-registry";
import { CommandRegistry } from "./core/commands/command-registry";
import { PaletteService } from "./core/commands/palette.service";
import { ShortcutService } from "./core/commands/shortcut.service";
import { DocumentService } from "./core/file/document.service";
import { BookmarksService } from "./core/bookmarks/bookmarks.service";
import { IndexService } from "./core/index/index.service";
import { AutoSyncService } from "./core/git/auto-sync.service";
import { CloneService } from "./core/git/clone.service";
import { GitService } from "./core/git/git.service";
import { SettingsPageService } from "./core/settings/settings-page.service";
import { overlaysNote, clampPanelWidth } from "./core/panel/panel-width";
import { PanelResizerComponent } from "./features/panel-resizer/panel-resizer.component";
import type { PanelTab } from "./core/settings/settings.service";
import { SettingsService } from "./core/settings/settings.service";
import { isPrerelease } from "./core/updater/update-logic";
import { UpdateService } from "./core/updater/update.service";
import { DailyService } from "./core/daily/daily.service";
import { ComposerService } from "./core/composer/composer.service";
import { TemplateService } from "./core/templates/template.service";
import { SwitcherService } from "./core/switcher/switcher.service";
import { WorkspacesService } from "./core/workspace/workspaces.service";
import { RecentPickerService, missingMessage } from "./core/workspace/recent-picker.service";
import { TREE_SORTS, TREE_SORT_LABELS } from "./core/workspace/tree-model";
import { VaultOpsService } from "./core/workspace/vault-ops.service";
import { WorkspaceService } from "./core/workspace/workspace.service";
import { BacklinksComponent } from "./features/backlinks/backlinks.component";
import { LinkPreviewComponent } from "./features/link-preview/link-preview.component";
import { OutlineComponent } from "./features/outline/outline.component";
import { RecentComponent } from "./features/recent/recent.component";
import { PaletteComponent } from "./features/palette/palette.component";
import { SearchComponent } from "./features/search/search.component";
import { ComposerComponent } from "./features/composer/composer.component";
import { TemplatesComponent } from "./features/templates/templates.component";
import { SwitcherComponent } from "./features/switcher/switcher.component";
import { SidebarComponent } from "./features/sidebar/sidebar.component";
import { CloneComponent } from "./features/clone/clone.component";
import { ConflictBarComponent } from "./features/conflict-bar/conflict-bar.component";
import { GitComponent } from "./features/git/git.component";
import { BookmarksComponent } from "./features/bookmarks/bookmarks.component";
import { HistoryComponent } from "./features/history/history.component";
import { StatusBarComponent } from "./features/status-bar/status-bar.component";
import { EditorSpikeComponent } from "./features/editor-spike/editor-spike.component";
import { GitSpikeComponent } from "./features/git-spike/git-spike.component";
import { ToolbarComponent } from "./features/toolbar/toolbar.component";
import { StartComponent } from "./features/start/start.component";
import { WorkspaceComponent } from "./features/workspace/workspace.component";
import { TabsService } from "./core/tabs/tabs.service";
import { FocusService } from "./core/shell/focus.service";
import { ShellService } from "./core/shell/shell.service";

/** Marks the template of an activity bar icon with the icon name of the views registry. */
@Directive({ selector: "ng-template[appNavIcon]" })
export class NavIconDirective {
  readonly name = input.required<string>({ alias: "appNavIcon" });
  readonly template = inject(TemplateRef);
}

@Component({
  selector: "app-root",
  imports: [
    HxToast,
    PanelResizerComponent,
    BookmarksComponent,
    HxActivityBar,
    HxAppShell,
    NavIconDirective,
    LinkPreviewComponent,
    OutlineComponent,
    BacklinksComponent,
    CloneComponent,
    ConflictBarComponent,
    GitComponent,
    HistoryComponent,
    StatusBarComponent,
    PaletteComponent,
    RecentComponent,
    SearchComponent,
    SwitcherComponent,
    TemplatesComponent,
    ComposerComponent,
    EditorSpikeComponent,
    GitSpikeComponent,
    ToolbarComponent,
    SidebarComponent,
    StartComponent,
    WorkspaceComponent,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
  host: { "(document:keydown)": "onKeydown($event)", "(window:resize)": "onResize()" },
})
export class AppComponent {
  protected readonly doc = inject(DocumentService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  private readonly captureShortcut = inject(CaptureShortcutService);
  private readonly index = inject(IndexService);
  private readonly ops = inject(VaultOpsService);
  protected readonly editor = inject(EditorService);
  protected readonly tabs = inject(TabsService);
  /** Registers the commands that select a view (toggle sidebar, search, files, Git). */
  protected readonly shell = inject(ShellService);
  /** Registers the commands that move the focus between file tree, note and panel. */
  private readonly focus = inject(FocusService);
  protected readonly git = inject(GitService);
  protected readonly cloneVault = inject(CloneService);
  private readonly autoSync = inject(AutoSyncService);
  protected readonly updater = inject(UpdateService);
  protected readonly switcher = inject(SwitcherService);
  protected readonly templates = inject(TemplateService);
  protected readonly composer = inject(ComposerService);
  private readonly daily = inject(DailyService);
  private readonly bookmarks = inject(BookmarksService);
  private readonly commands = inject(CommandRegistry);
  protected readonly palette = inject(PaletteService);
  protected readonly recent = inject(RecentPickerService);
  private readonly workspaces = inject(WorkspacesService);
  protected readonly settingsPage = inject(SettingsPageService);
  /** Applies the user's shortcuts to the key handling and the native menu. */
  private readonly shortcuts = inject(ShortcutService);

  protected readonly gitSpike = isDevMode();
  private readonly messages = inject(HxMessageService);

  private readonly icons = viewChildren(NavIconDirective);

  /** The activity bar items with their icons: the registry names an icon, the templates draw it. */
  protected readonly barItems = computed(() => {
    const templates = new Map(this.icons().map((i) => [i.name(), i.template]));
    return this.shell.items().map((item) => ({
      ...item,
      icon: typeof item.icon === "string" ? (templates.get(item.icon) ?? item.icon) : item.icon,
    }));
  });

  /** The Links tab needs a vault; outside one the panel only has the outline. */
  protected readonly linksAvailable = computed(() => this.workspace.vaultRoot() !== null);

  protected readonly windowWidth = signal(window.innerWidth);

  protected onResize(): void {
    this.windowWidth.set(window.innerWidth);
  }

  /** Width the sidebar takes right now. */
  protected readonly sidebarShown = computed(() =>
    this.shell.shownView() === null ? 0 : this.settings.sidebarWidth(),
  );
  /** Too narrow for the panel next to a note of 320px: the panel floats over the note. */
  protected readonly panelOverlays = computed(() =>
    overlaysNote(this.windowWidth(), this.sidebarShown()),
  );
  /** The stored width within what the window allows. */
  protected readonly panelWidthShown = computed(() =>
    clampPanelWidth(this.settings.panelWidth(), this.windowWidth(), this.sidebarShown()),
  );

  protected readonly showPanel = computed(
    () => this.doc.path() !== null && this.settings.panelOpen(),
  );

  protected readonly panelTab = computed<PanelTab>(() =>
    this.settings.panelTab() === "links" && this.linksAvailable() ? "links" : "outline",
  );

  protected readonly showSwitcher = computed(
    () => this.workspace.vaultRoot() !== null && this.switcher.visible(),
  );

  constructor() {
    effect(() => {
      const path = this.doc.path();
      if (path) untracked(() => this.switcher.noteOpened(path));
    });

    effect(() => {
      const name = this.doc.path()?.endsWith(STDIN_FILE_SUFFIX) ? "stdin" : this.doc.fileName();
      void getCurrentWindow().setTitle(name ? `${name} – Nixe` : "Nixe");
    });

    // Keep the tree in sync with navigation via links and history.
    effect(() => {
      const path = this.doc.path();
      if (path) void this.workspace.reveal(path);
    });

    effect(() => {
      const error = this.captureShortcut.error();
      if (error !== null) untracked(() => this.showToast(`Capture shortcut: ${error}`));
    });

    effect(() => {
      const notice = this.tabs.notice();
      if (notice === null) return;
      untracked(() => {
        this.showToast(notice);
        this.tabs.notice.set(null);
      });
    });

    effect(() => {
      const notice = this.bookmarks.notice();
      if (notice === null) return;
      untracked(() => {
        this.showToast(notice);
        this.bookmarks.notice.set(null);
      });
    });

    effect(() => {
      const notice = this.recent.notice();
      if (notice === null) return;
      untracked(() => {
        this.showToast(notice);
        this.recent.notice.set(null);
      });
    });

    this.registerCommands();
    void this.initDesktopIntegration();
  }

  private async initDesktopIntegration(): Promise<void> {
    // Desktop-only listeners must not stop the pending file from opening
    // (on iOS some of them are unavailable).
    try {
      await listen(OPEN_FILE_EVENT, () => void this.openPending());
      await listen<string>(FILE_CHANGED_EVENT, (e) => void this.tabs.onExternalChange(e.payload));
      await this.updater.init();
      await this.index.init();
      await this.bookmarks.init();
      await this.workspaces.refreshSaved();
      await this.autoSync.listenWindow();
      await listen<string>(MENU_EVENT, (e) => this.commands.execute(e.payload));

      await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (!paths[0]) return;
        const handle = this.editor.editing() ? this.editor.handle : null;
        if (handle) void this.run(() => handle.attachPaths(paths));
        else void this.openPath(paths[0]);
      });
    } catch (err) {
      console.warn("desktop integration unavailable", err);
    }

    // A file or folder passed on the command line may already be waiting;
    // otherwise the last opened folder is restored.
    if (!(await this.openPending())) {
      const last = this.settings.lastFolder();
      if (last) {
        await this.run(async () => {
          if (!(await this.workspace.openRecent(last)))
            this.recent.notice.set(missingMessage([last]));
        });
      }
    }
  }

  private async openPending(): Promise<boolean> {
    const path = await backend.takePendingFile();
    if (!path) return false;
    await this.openPath(path);
    return true;
  }

  /** Opens a file, or a folder in the sidebar. */
  protected async openPath(path: string): Promise<void> {
    await this.run(async () => {
      if (await backend.isDir(path)) await this.workspace.openFolder(path);
      else await this.doc.open(path);
    });
  }

  /** A short notice; messages stack and go away by themselves. */
  protected showToast(message: string): void {
    this.messages.add({ severity: "info", summary: message, life: 4000 });
  }

  /** An error stays until the user closes it. */
  protected showError(message: string): void {
    this.messages.add({ severity: "error", summary: message, sticky: true });
  }

  protected async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.showError(String(err));
    }
  }

  /** Registers the actions of the app; the menu, the shortcuts and the palette run them by id. */
  private registerCommands(): void {
    const inVault = () => this.workspace.vaultRoot() !== null;
    const noteOpen = () => this.doc.path() !== null;
    const commands: Command[] = [
      {
        id: "command-palette",
        title: "Command palette",
        shortcut: "Mod+P",
        keys: ["Mod+P"],
        run: () => this.palette.open(),
      },
      {
        id: "new-note",
        title: "New note",
        shortcut: "Mod+N",
        keys: ["Mod+N"],
        when: inVault,
        run: () => this.newNote(),
      },
      {
        id: "new-folder",
        title: "New folder",
        when: inVault,
        run: () =>
          this.run(async () => void (await this.ops.createFolder(this.workspace.root() as string))),
      },
      ...TREE_SORTS.map((sort) => ({
        id: `sort-file-tree-${sort}`,
        title: `Sort file tree: ${TREE_SORT_LABELS[sort]}`,
        when: inVault,
        run: () => this.run(() => this.workspace.setSort(sort)),
      })),
      {
        id: "reveal-active-note",
        title: "Reveal the active note in the file tree",
        when: noteOpen,
        run: () => this.run(() => this.workspace.revealActive()),
      },
      {
        id: "collapse-all-folders",
        title: "Collapse all folders in the file tree",
        when: inVault,
        run: () => this.workspace.collapseAll(),
      },
      {
        id: "reload-file-tree",
        title: "Reload file tree",
        when: inVault,
        run: () => this.run(() => this.workspace.reloadTree()),
      },
      {
        id: "quick-switcher",
        title: "Quick switcher",
        shortcut: "Mod+O",
        keys: ["Mod+O"],
        when: inVault,
        run: () => this.switcher.open(),
      },
      {
        id: "daily-note",
        title: "Open today's daily note",
        shortcut: "Mod+Shift+D",
        keys: ["Mod+Shift+D"],
        when: inVault,
        run: () => this.run(() => this.daily.openToday()),
      },
      {
        id: "daily-previous",
        title: "Open previous daily note",
        when: inVault,
        run: () => this.run(() => this.daily.previous()),
      },
      {
        id: "daily-next",
        title: "Open next daily note",
        when: inVault,
        run: () => this.run(() => this.daily.next()),
      },
      {
        id: "insert-template",
        title: "Insert template",
        when: () => noteOpen() && this.editor.editing(),
        run: () => this.run(() => this.templates.open()),
      },
      {
        id: "toggle-editor",
        title: "Toggle editor",
        shortcut: "Mod+E",
        when: noteOpen,
        run: () =>
          this.run(() => this.editor.toggle(this.tabs.activeTab().viewer?.topLine() ?? null)),
      },
      {
        id: "bookmark-note",
        title: "Bookmark the note (or remove it)",
        when: noteOpen,
        run: () => this.bookmarks.toggleNote(),
      },
      {
        id: "bookmark-heading",
        title: "Bookmark the heading at the top (or remove it)",
        when: noteOpen,
        run: () =>
          void (
            this.bookmarks.bookmarkCurrentHeading() || this.showToast("The note has no heading.")
          ),
      },
      {
        id: "bookmark-search",
        title: "Bookmark the search (or remove it)",
        when: inVault,
        run: () => void (this.bookmarks.bookmarkSearch() || this.showToast("The search is empty.")),
      },
      {
        id: "show-bookmarks",
        title: "Show bookmarks",
        when: inVault,
        run: () => this.shell.show("bookmarks"),
      },
      {
        id: "extract-selection",
        title: "Extract selection to a note",
        when: () => noteOpen() && this.editor.editing(),
        run: () => this.run(() => this.composer.extractSelection()),
      },
      {
        id: "extract-heading",
        title: "Extract heading to a note",
        when: () => noteOpen() && this.editor.editing(),
        run: () => this.run(() => this.composer.extractHeading()),
      },
      {
        id: "merge-into",
        title: "Merge into…",
        when: noteOpen,
        run: () => this.run(() => this.composer.mergeInto()),
      },
      { id: "fold", title: "Fold at the cursor", when: noteOpen, run: () => this.foldNote("fold") },
      {
        id: "unfold",
        title: "Unfold at the cursor",
        when: noteOpen,
        run: () => this.foldNote("unfold"),
      },
      { id: "fold-all", title: "Fold all", when: noteOpen, run: () => this.foldNote("fold-all") },
      {
        id: "unfold-all",
        title: "Unfold all",
        when: noteOpen,
        run: () => this.foldNote("unfold-all"),
      },
      {
        id: "find",
        title: "Find in note",
        shortcut: "Mod+F",
        keys: ["Mod+F"],
        when: () => noteOpen() && !this.editor.editing(),
        run: () => this.tabs.activeTab().viewer?.openFind(),
      },
      {
        id: "new-tab",
        title: "New tab",
        shortcut: "Mod+T",
        run: () => this.run(async () => void this.tabs.newTab()),
      },
      { id: "close-tab", title: "Close tab", shortcut: "Mod+W", run: () => this.closeTab() },
      {
        id: "next-tab",
        title: "Next tab",
        shortcut: "Ctrl+Tab",
        keys: ["Ctrl+Tab"],
        run: () => this.tabs.cycle(1),
      },
      {
        id: "previous-tab",
        title: "Previous tab",
        shortcut: "Ctrl+Shift+Tab",
        keys: ["Ctrl+Shift+Tab"],
        run: () => this.tabs.cycle(-1),
      },
      {
        id: "split-right",
        title: "Split tab to the right",
        when: noteOpen,
        run: () => this.run(() => this.tabs.splitRight()),
      },
      {
        id: "unsplit",
        title: "Merge the split panes",
        when: () => this.tabs.split(),
        run: () => this.tabs.unsplit(),
      },
      {
        id: "focus-other-pane",
        title: "Focus the other pane",
        when: () => this.tabs.split(),
        run: () => this.tabs.focusNextPane(),
      },
      {
        id: "open-settings",
        title: "Open settings",
        shortcut: "Mod+,",
        keys: ["Mod+,"],
        run: () =>
          this.run(async () => {
            this.tabs.openView("settings");
            await this.settingsPage.open();
          }),
      },
      {
        id: "open-file",
        title: "Open file",
        shortcut: "Mod+Shift+P",
        run: () => this.run(() => this.doc.openWithDialog()),
      },
      {
        id: "open-folder",
        title: "Open folder",
        shortcut: "Mod+Shift+O",
        run: () => this.run(() => this.workspace.openFolderWithDialog()),
      },
      {
        id: "check-updates",
        title: "Check for updates…",
        when: () => !isPrerelease(this.updater.version()),
        run: () => this.updater.check(),
      },
      {
        id: "add-folder-to-workspace",
        title: "Add folder to workspace…",
        when: () => this.workspace.root() !== null,
        run: () => this.run(() => this.workspaces.addFolderWithDialog()),
      },
      {
        id: "save-workspace",
        title: "Save workspace",
        when: () => this.workspaces.current() !== null,
        run: () => this.run(() => this.workspaces.save()),
      },
      {
        id: "open-recent",
        title: "Open recent vault…",
        run: () => this.run(() => this.recent.open()),
      },
      { id: "clone-vault", title: "Clone vault…", run: () => this.cloneVault.open() },
      {
        id: "reload",
        title: "Reload",
        shortcut: "Mod+R",
        run: () =>
          this.run(async () => {
            await this.doc.reload();
            await this.workspace.refresh();
          }),
      },
      {
        id: "back",
        title: "Back",
        shortcut: "Mod+[",
        keys: ["Alt+ArrowLeft"],
        run: () => this.run(() => this.doc.back()),
      },
      {
        id: "forward",
        title: "Forward",
        shortcut: "Mod+]",
        keys: ["Alt+ArrowRight"],
        run: () => this.run(() => this.doc.forward()),
      },
      {
        id: "vault-health",
        title: "Vault health",
        when: inVault,
        run: () => this.run(async () => void this.tabs.openView("health")),
      },
      {
        id: "git-sync",
        title: "Sync with the remote",
        shortcut: "Mod+Shift+S",
        keys: ["Mod+Shift+S"],
        when: () => this.git.available(),
        run: () => this.git.sync(),
      },
      {
        id: "toggle-backlinks",
        title: "Toggle backlinks panel",
        shortcut: "Mod+Shift+B",
        when: inVault,
        run: () => this.settings.togglePanelTab("links"),
      },
      {
        id: "toggle-outline",
        title: "Toggle outline panel",
        shortcut: "Mod+Shift+L",
        when: noteOpen,
        run: () => this.settings.togglePanelTab("outline"),
      },
      {
        id: "toggle-link-preview",
        title: "Link preview: always on hover / only with ⌘/Ctrl held",
        run: () =>
          this.settings.linkPreview.update((m) => (m === "always" ? "modifier" : "always")),
      },
      {
        id: "toggle-math",
        title: "Toggle LaTeX math",
        run: () => this.settings.math.update((v) => !v),
      },
      {
        id: "cycle-theme",
        title: "Cycle theme (system, light, dark)",
        run: () => this.settings.cycleTheme(),
      },
      { id: "zoom-in", title: "Zoom in", shortcut: "Mod+=", run: () => this.settings.zoomIn() },
      { id: "zoom-out", title: "Zoom out", shortcut: "Mod+-", run: () => this.settings.zoomOut() },
      {
        id: "zoom-reset",
        title: "Actual size",
        shortcut: "Mod+0",
        run: () => this.settings.resetZoom(),
      },
    ];
    for (const command of commands) this.commands.register(command);
  }

  /** Folds in the editor while it is open, else the headings of the reading view. */
  private foldNote(action: "fold" | "unfold" | "fold-all" | "unfold-all"): void {
    const tab = this.tabs.activeTab();
    if (tab.editor.editing()) tab.editor.handle?.fold?.(action);
    else tab.viewer?.fold(action);
  }

  /** Closes the shown tab; the window closes when there is only an empty tab left. */
  private closeTab(): void {
    if (this.tabs.closeTab()) return;
    void getCurrentWindow()
      .close()
      .catch(() => undefined);
  }

  /** A new note in the new-note folder of the vault, opened in the editor. */
  private newNote(): void {
    if (this.workspace.vaultRoot() === null) return;
    void this.run(async () => {
      await this.ops.createNote();
      if (!this.editor.editing()) await this.editor.toggle(null);
    });
  }

  /** Keys the webview handles itself; the native menu accelerators cover the other shortcuts. */
  protected onKeydown(event: KeyboardEvent): void {
    if (this.focus.handleEscape(event)) {
      event.preventDefault();
      return;
    }
    const command = this.commands.findByKey(event);
    if (command && this.commands.execute(command.id)) event.preventDefault();
  }
}
