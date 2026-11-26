import { CaptureShortcutService } from "./core/capture/capture-shortcut.service";
import {
  Component,
  computed,
  effect,
  inject,
  isDevMode,
  signal,
  untracked,
  viewChildren,
} from "@angular/core";
import { HxActivityBar, HxAppShell } from "@gravionlabs/helix-desktop";
import { HxUpdateService } from "@gravionlabs/helix-desktop/tauri";
import { HxMessageService, HxToast } from "@gravionlabs/helix-ui";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  FILE_CHANGED_EVENT,
  ROOTS_CHANGED_EVENT,
  MENU_EVENT,
  EXPORT_EVENT,
  OPEN_FILE_EVENT,
  VAULT_CHANGED_EVENT,
  STDIN_FILE_SUFFIX,
  backend,
  type ExportRequest,
  type VaultChange,
} from "./core/file/backend";
import { LogActionsService } from "./core/log/log-actions.service";
import { LogService } from "./core/log/log.service";
import { EditorService } from "./core/editor/editor.service";
import type { Command } from "./core/commands/command-registry";
import { CommandRegistry } from "./core/commands/command-registry";
import { PaletteService } from "./core/commands/palette.service";
import { ShortcutService } from "./core/commands/shortcut.service";
import { ExportService } from "./core/export/export.service";
import type { ExportFormat } from "./core/export/export-core";
import { DocumentService } from "./core/file/document.service";
import { BookmarksService } from "./core/bookmarks/bookmarks.service";
import { IndexService } from "./core/index/index.service";
import { AutoSyncService } from "./core/git/auto-sync.service";
import { CloneService } from "./core/git/clone.service";
import { GitService } from "./core/git/git.service";
import { SettingsPageService } from "./core/settings/settings-page.service";
import { overlaysNote, clampPanelWidth } from "./core/panel/panel-width";
import { TerminalPanelComponent } from "./features/terminal/terminal-panel.component";
import { TerminalService } from "./core/terminal/terminal.service";
import { PanelResizerComponent } from "./features/panel-resizer/panel-resizer.component";
import type { ViewMode } from "./core/settings/settings-core";
import type { PanelTab } from "./core/settings/settings.service";
import { SettingsService } from "./core/settings/settings.service";
import { DailyService } from "./core/daily/daily.service";
import { ComposerService } from "./core/composer/composer.service";
import { SwitcherService } from "./core/switcher/switcher.service";
import { RootChoiceComponent } from "./features/workspace/root-choice.component";
import { WorkspacesService, skippedMessage } from "./core/workspace/workspaces.service";
import { VaultUndoService } from "./core/workspace/vault-undo.service";
import { RecentPickerService, missingMessage } from "./core/workspace/recent-picker.service";
import { TREE_SORTS, TREE_SORT_LABELS } from "./core/workspace/tree-model";
import { VaultOpsService } from "./core/workspace/vault-ops.service";
import { WorkspaceService } from "./core/workspace/workspace.service";
import { BacklinksComponent } from "./features/backlinks/backlinks.component";
import { RelatedComponent } from "./features/related/related.component";
import { LinkPreviewComponent } from "./features/link-preview/link-preview.component";
import { OutlineComponent } from "./features/outline/outline.component";
import { PropertiesPanelComponent } from "./features/properties/properties-panel.component";
import { PaletteComponent } from "./features/palette/palette.component";
import { SearchComponent } from "./features/search/search.component";
import { ComposerComponent } from "./features/composer/composer.component";
import { SidebarComponent } from "./features/sidebar/sidebar.component";
import { CloneComponent } from "./features/clone/clone.component";
import { FolderRoleComponent } from "./features/folder-role/folder-role.component";
import { FolderRolesService } from "./core/workspace/folder-roles.service";
import { VaultSkillsService } from "./core/workspace/vault-skills.service";
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
import { NavIconDirective } from "./nav-icon.directive";

@Component({
  selector: "app-root",
  imports: [
    HxToast,
    PanelResizerComponent,
    TerminalPanelComponent,
    BookmarksComponent,
    HxActivityBar,
    HxAppShell,
    NavIconDirective,
    LinkPreviewComponent,
    OutlineComponent,
    PropertiesPanelComponent,
    BacklinksComponent,
    RelatedComponent,
    CloneComponent,
    FolderRoleComponent,
    ConflictBarComponent,
    GitComponent,
    HistoryComponent,
    StatusBarComponent,
    PaletteComponent,
    SearchComponent,
    ComposerComponent,
    EditorSpikeComponent,
    GitSpikeComponent,
    ToolbarComponent,
    SidebarComponent,
    StartComponent,
    WorkspaceComponent,
    RootChoiceComponent,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
  host: { "(document:keydown)": "onKeydown($event)", "(window:resize)": "onResize()" },
})
export class AppComponent {
  private readonly exporter = inject(ExportService);
  private readonly log = inject(LogService);
  private readonly logActions = inject(LogActionsService);
  protected readonly doc = inject(DocumentService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  protected readonly terminal = inject(TerminalService);
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
  protected readonly folderRoles = inject(FolderRolesService);
  private readonly autoSync = inject(AutoSyncService);
  protected readonly updater = inject(HxUpdateService);
  protected readonly switcher = inject(SwitcherService);
  protected readonly composer = inject(ComposerService);
  private readonly daily = inject(DailyService);
  private readonly bookmarks = inject(BookmarksService);
  private readonly vaultUndo = inject(VaultUndoService);
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
    this.settings.panelTab() === "properties" ||
    (this.settings.panelTab() !== "outline" && this.linksAvailable())
      ? this.settings.panelTab()
      : "outline",
  );

  constructor() {
    // Registers the command "Update vault skills".
    inject(VaultSkillsService);

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
      const notice = this.terminal.notice();
      if (notice === null) return;
      untracked(() => {
        this.showToast(notice);
        this.terminal.notice.set(null);
      });
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

    effect(() => {
      const notice = this.workspace.notice();
      if (notice === null) return;
      untracked(() => {
        this.showToast(notice);
        this.workspace.notice.set(null);
      });
    });

    effect(() => {
      const skipped = this.workspaces.skipped();
      if (skipped === null) return;
      untracked(() => {
        this.messages.add({
          severity: "warn",
          summary: skippedMessage(skipped),
          sticky: true,
          action: {
            label: "Set variable",
            run: () =>
              void this.run(async () => {
                this.tabs.openView("settings");
                await this.settingsPage.open();
                this.settingsPage.select("locations");
              }),
          },
        });
        this.workspaces.skipped.set(null);
      });
    });

    effect(() => {
      const notice = this.vaultUndo.notice();
      if (notice === null) return;
      untracked(() => {
        if (notice.error) this.showError(notice.text);
        else if (notice.undo) {
          this.messages.add({
            severity: "info",
            summary: notice.text,
            life: 8000,
            action: { label: "Undo", run: () => void this.vaultUndo.undo() },
          });
        } else this.showToast(notice.text);
        this.vaultUndo.notice.set(null);
      });
    });

    // The level of the log applies at once, also the one read from the settings file.
    effect(() => {
      const level = this.settings.logLevel();
      untracked(() => void this.logActions.setLevel(level));
    });
    void this.logActions.loadFolder();

    this.registerCommands();
    void this.initDesktopIntegration();
  }

  private async initDesktopIntegration(): Promise<void> {
    // Desktop-only listeners must not stop the pending file from opening
    // (on iOS some of them are unavailable).
    try {
      await listen(OPEN_FILE_EVENT, () => void this.openPending());
      await listen(EXPORT_EVENT, () => void this.runPendingExport());
      await listen<string>(FILE_CHANGED_EVENT, (e) => void this.tabs.onExternalChange(e.payload));
      await listen(ROOTS_CHANGED_EVENT, () => void this.workspace.reloadExtraRoots());
      await listen<VaultChange[]>(
        VAULT_CHANGED_EVENT,
        (e) => void this.workspace.onVaultChanged(e.payload ?? []),
      );
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

    // A headless `nixe export` shows no window and needs nothing else to start.
    if ((await this.runPendingExport())?.headless) return;

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

  /** Export as HTML asks for the file; PDF and print open the print dialog ("Save as PDF" there). */
  private async exportNote(format: ExportFormat | "print"): Promise<void> {
    await this.run(async () => {
      const file = await this.exporter.exportCurrent(format);
      if (file) this.showToast(`Exported ${file}`);
    });
  }

  /** Export folder as site asks for the folder and for where to write the pages. */
  private async exportSite(): Promise<void> {
    await this.run(async () => {
      const site = await this.exporter.exportSite();
      if (site) this.showToast(`Exported ${site.pages} pages to ${site.out}`);
    });
  }

  /** `nixe export`: runs the request and, without a window, ends the process with its result. */
  private async runPendingExport(): Promise<ExportRequest | null> {
    let request: ExportRequest | null;
    try {
      request = await backend.takePendingExport();
    } catch (err) {
      // Ends a headless export (a no-op in a normal window), which would otherwise hang hidden.
      await backend.finishExport(1, String(err)).catch(() => undefined);
      return null;
    }
    if (!request) return null;
    try {
      const file = await this.exporter.runRequest(request);
      if (request.headless) await backend.finishExport(0, file ?? "");
      else if (file) this.showToast(`Exported ${file}`);
    } catch (err) {
      if (request.headless) await backend.finishExport(1, String(err));
      else this.showError(String(err));
    }
    return request;
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
    this.log.write("error", message);
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
        group: "Navigate",
        title: "Command palette",
        shortcut: "Mod+P",
        keys: ["Mod+P"],
        run: () => this.palette.open(">"),
      },
      {
        id: "new-note",
        group: "File",
        title: "New note",
        shortcut: "Mod+N",
        keys: ["Mod+N"],
        when: inVault,
        run: () => this.newNote(),
      },
      {
        id: "new-folder",
        group: "File",
        title: "New folder",
        when: inVault,
        run: () =>
          this.run(async () => void (await this.ops.createFolder(this.workspace.root() as string))),
      },
      ...TREE_SORTS.map((sort) => ({
        id: `sort-file-tree-${sort}`,
        group: "File" as const,
        title: `Sort file tree: ${TREE_SORT_LABELS[sort]}`,
        when: inVault,
        run: () => this.run(() => this.workspace.setSort(sort)),
      })),
      {
        id: "reveal-active-note",
        group: "File",
        title: "Reveal the active note in the file tree",
        when: noteOpen,
        run: () => this.run(() => this.workspace.revealActive()),
      },
      {
        id: "collapse-all-folders",
        group: "File",
        title: "Collapse all folders in the file tree",
        when: inVault,
        run: () => this.workspace.collapseAll(),
      },
      {
        id: "reload-file-tree",
        group: "File",
        title: "Reload file tree",
        when: inVault,
        run: () => this.run(() => this.workspace.reloadTree()),
      },
      {
        id: "quick-switcher",
        group: "Navigate",
        title: "Quick switcher",
        shortcut: "Mod+O",
        keys: ["Mod+O"],
        when: inVault,
        run: () => this.palette.open(),
      },
      {
        id: "daily-note",
        group: "File",
        title: "Open today's daily note",
        shortcut: "Mod+Shift+D",
        keys: ["Mod+Shift+D"],
        when: inVault,
        run: () => this.run(() => this.daily.openToday()),
      },
      {
        id: "daily-previous",
        group: "File",
        title: "Open previous daily note",
        when: inVault,
        run: () => this.run(() => this.daily.previous()),
      },
      {
        id: "daily-next",
        group: "File",
        title: "Open next daily note",
        when: inVault,
        run: () => this.run(() => this.daily.next()),
      },
      {
        id: "insert-template",
        group: "File",
        title: "Insert template",
        when: () => noteOpen() && this.editor.editing(),
        run: () => this.run(() => this.palette.openTemplates()),
      },
      {
        id: "toggle-editor",
        group: "View",
        title: "Toggle source mode",
        shortcut: "Mod+E",
        when: noteOpen,
        run: () =>
          this.run(() => this.editor.toggleMode(this.tabs.activeTab().viewer?.topLine() ?? null)),
      },
      {
        id: "toggle-reading",
        group: "View",
        title: "Toggle reading view",
        shortcut: "Mod+Alt+E",
        when: noteOpen,
        run: () =>
          this.run(() =>
            this.editor.toggleReading(this.tabs.activeTab().viewer?.topLine() ?? null),
          ),
      },
      {
        id: "view-live",
        group: "View",
        title: "Live preview",
        when: noteOpen,
        run: () => this.setViewMode("live"),
      },
      {
        id: "view-source",
        group: "View",
        title: "Source",
        when: noteOpen,
        run: () => this.setViewMode("source"),
      },
      {
        id: "view-reading",
        group: "View",
        title: "Reading",
        when: noteOpen,
        run: () => this.setViewMode("reading"),
      },
      {
        id: "undo-vault-operation",
        group: "Edit",
        title: "Undo last vault operation",
        when: inVault,
        run: () => void this.vaultUndo.undo(),
      },
      {
        id: "bookmark-note",
        group: "Navigate",
        title: "Bookmark the note (or remove it)",
        when: noteOpen,
        run: () => this.bookmarks.toggleNote(),
      },
      {
        id: "bookmark-heading",
        group: "Navigate",
        title: "Bookmark the heading at the top (or remove it)",
        when: noteOpen,
        run: () =>
          void (
            this.bookmarks.bookmarkCurrentHeading() || this.showToast("The note has no heading.")
          ),
      },
      {
        id: "bookmark-search",
        group: "Navigate",
        title: "Bookmark the search (or remove it)",
        when: inVault,
        run: () => void (this.bookmarks.bookmarkSearch() || this.showToast("The search is empty.")),
      },
      {
        id: "show-bookmarks",
        group: "Navigate",
        title: "Show bookmarks",
        when: inVault,
        run: () => this.shell.show("bookmarks"),
      },
      {
        id: "show-links",
        group: "Navigate",
        title: "Show links",
        when: inVault,
        run: () => this.run(async () => void this.tabs.openView("links")),
      },
      {
        id: "extract-selection",
        group: "Edit",
        title: "Extract selection to a note",
        when: () => noteOpen() && this.editor.editing(),
        run: () => this.run(() => this.composer.extractSelection()),
      },
      {
        id: "extract-heading",
        group: "Edit",
        title: "Extract heading to a note",
        when: () => noteOpen() && this.editor.editing(),
        run: () => this.run(() => this.composer.extractHeading()),
      },
      {
        id: "merge-into",
        group: "Edit",
        title: "Merge into…",
        when: noteOpen,
        run: () => this.run(() => this.composer.mergeInto()),
      },
      {
        id: "fold",
        group: "Edit",
        title: "Fold at the cursor",
        when: noteOpen,
        run: () => this.foldNote("fold"),
      },
      {
        id: "unfold",
        group: "Edit",
        title: "Unfold at the cursor",
        when: noteOpen,
        run: () => this.foldNote("unfold"),
      },
      {
        id: "fold-all",
        group: "Edit",
        title: "Fold all",
        when: noteOpen,
        run: () => this.foldNote("fold-all"),
      },
      {
        id: "unfold-all",
        group: "Edit",
        title: "Unfold all",
        when: noteOpen,
        run: () => this.foldNote("unfold-all"),
      },
      {
        id: "find",
        group: "Edit",
        title: "Find in note",
        shortcut: "Mod+F",
        keys: ["Mod+F"],
        when: () => noteOpen() && !this.editor.editing(),
        run: () => this.tabs.activeTab().viewer?.openFind(),
      },
      {
        id: "new-tab",
        group: "File",
        title: "New tab",
        shortcut: "Mod+T",
        run: () => this.run(async () => void this.tabs.newTab()),
      },
      {
        id: "keep-tab-open",
        group: "File",
        title: "Keep tab open",
        shortcut: "Mod+Alt+K",
        keys: ["Mod+Alt+K"],
        when: () => this.settings.previewTabs() && this.tabs.isPreview(this.tabs.activeTab()),
        run: () => this.tabs.keepOpen(),
      },
      {
        id: "close-tab",
        group: "File",
        title: "Close tab",
        shortcut: "Mod+W",
        run: () => this.closeTab(),
      },
      {
        id: "next-tab",
        group: "Navigate",
        title: "Next tab",
        shortcut: "Ctrl+Tab",
        keys: ["Ctrl+Tab"],
        run: () => this.tabs.cycle(1),
      },
      {
        id: "previous-tab",
        group: "Navigate",
        title: "Previous tab",
        shortcut: "Ctrl+Shift+Tab",
        keys: ["Ctrl+Shift+Tab"],
        run: () => this.tabs.cycle(-1),
      },
      {
        id: "split-right",
        group: "Navigate",
        title: "Split tab to the right",
        when: noteOpen,
        run: () => this.run(() => this.tabs.splitRight()),
      },
      {
        id: "unsplit",
        group: "Navigate",
        title: "Merge the split panes",
        when: () => this.tabs.split(),
        run: () => this.tabs.unsplit(),
      },
      {
        id: "focus-other-pane",
        group: "Navigate",
        title: "Focus the other pane",
        when: () => this.tabs.split(),
        run: () => this.tabs.focusNextPane(),
      },
      {
        id: "open-settings",
        group: "File",
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
        group: "File",
        title: "Open file",
        shortcut: "Mod+Shift+P",
        run: () => this.run(() => this.doc.openWithDialog()),
      },
      {
        id: "open-folder",
        group: "File",
        title: "Open folder",
        shortcut: "Mod+Shift+O",
        run: () => this.run(() => this.workspace.openFolderWithDialog()),
      },
      {
        id: "check-updates",
        group: "File",
        title: "Check for updates…",
        run: () => this.updater.check({ manual: true }),
      },
      {
        id: "add-folder-to-workspace",
        group: "File",
        title: "Add folder to workspace…",
        when: () => this.workspace.root() !== null,
        run: () => this.run(() => this.workspaces.addFolderWithDialog()),
      },
      {
        id: "save-workspace",
        group: "File",
        title: "Save workspace",
        when: () => this.workspaces.current() !== null,
        run: () => this.run(() => this.workspaces.save()),
      },
      {
        id: "open-recent",
        group: "File",
        title: "Open recent vault…",
        run: () => this.palette.open("~"),
      },
      {
        id: "clone-vault",
        group: "File",
        title: "Clone vault…",
        run: () => this.cloneVault.open(),
      },
      {
        id: "reload",
        group: "File",
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
        group: "Navigate",
        title: "Back",
        shortcut: "Mod+[",
        keys: ["Alt+ArrowLeft"],
        run: () => this.run(() => this.doc.back()),
      },
      {
        id: "forward",
        group: "Navigate",
        title: "Forward",
        shortcut: "Mod+]",
        keys: ["Alt+ArrowRight"],
        run: () => this.run(() => this.doc.forward()),
      },
      {
        id: "show-log",
        group: "Other",
        title: "Show log",
        run: () => this.logActions.show(),
      },
      {
        id: "copy-log",
        group: "Other",
        title: "Copy log",
        run: () => this.logActions.copy(),
      },
      {
        id: "reveal-log-folder",
        group: "Other",
        title: "Reveal log folder",
        run: () => this.logActions.reveal(),
      },
      {
        id: "vault-health",
        group: "Vault",
        title: "Vault health",
        when: inVault,
        run: () => this.run(async () => void this.tabs.openView("health")),
      },
      {
        id: "export-html",
        group: "Export",
        title: "Export as HTML",
        when: noteOpen,
        run: () => this.exportNote("html"),
      },
      {
        id: "export-site",
        group: "Export",
        title: "Export folder as site",
        when: inVault,
        run: () => this.exportSite(),
      },
      {
        id: "export-pdf",
        group: "Export",
        title: "Export as PDF",
        when: noteOpen,
        run: () => this.exportNote("pdf"),
      },
      {
        id: "print",
        group: "Export",
        title: "Print",
        shortcut: "Mod+Alt+P",
        keys: ["Mod+Alt+P"],
        when: noteOpen,
        run: () => this.exportNote("print"),
      },
      {
        id: "git-sync",
        group: "Git",
        title: "Sync with the remote",
        shortcut: "Mod+Shift+S",
        keys: ["Mod+Shift+S"],
        when: () => this.git.available(),
        run: () => this.git.sync(),
      },
      {
        id: "toggle-backlinks",
        group: "View",
        title: "Toggle backlinks panel",
        shortcut: "Mod+Shift+B",
        when: inVault,
        run: () => this.settings.togglePanelTab("links"),
      },
      {
        id: "toggle-related",
        group: "View",
        title: "Toggle related notes panel",
        when: inVault,
        run: () => this.settings.togglePanelTab("related"),
      },
      {
        id: "toggle-outline",
        group: "View",
        title: "Toggle outline panel",
        shortcut: "Mod+Shift+L",
        when: noteOpen,
        run: () => this.settings.togglePanelTab("outline"),
      },
      {
        id: "show-properties-panel",
        group: "View",
        title: "Show properties panel",
        when: noteOpen,
        run: () => this.settings.showPanelTab("properties"),
      },
      {
        id: "toggle-properties",
        group: "View",
        title: "Toggle properties",
        shortcut: "Mod+Alt+P",
        when: noteOpen,
        run: () => this.settings.toggleProperties(),
      },
      {
        id: "toggle-link-preview",
        group: "View",
        title: "Link preview: always on hover / only with ⌘/Ctrl held",
        run: () =>
          this.settings.linkPreview.update((m) => (m === "always" ? "modifier" : "always")),
      },
      {
        id: "toggle-math",
        group: "View",
        title: "Toggle LaTeX math",
        run: () => this.settings.math.update((v) => !v),
      },
      {
        id: "cycle-theme",
        group: "View",
        title: "Cycle theme (system, light, dark)",
        run: () => this.settings.cycleTheme(),
      },
      {
        id: "zoom-in",
        group: "View",
        title: "Zoom in",
        shortcut: "Mod+=",
        run: () => this.settings.zoomIn(),
      },
      {
        id: "zoom-out",
        group: "View",
        title: "Zoom out",
        shortcut: "Mod+-",
        run: () => this.settings.zoomOut(),
      },
      {
        id: "zoom-reset",
        group: "View",
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

  /** Switches the active tab to a view mode (the toolbar control, the View menu, the palette). */
  private setViewMode(mode: ViewMode): void {
    void this.run(() => this.editor.setMode(mode, this.tabs.activeTab().viewer?.topLine() ?? null));
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
