import { Component, computed, effect, inject, isDevMode, signal, untracked, viewChild } from "@angular/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { FILE_CHANGED_EVENT, MENU_EVENT, OPEN_FILE_EVENT, STDIN_FILE_SUFFIX, backend } from "./core/file/backend";
import { EditorService } from "./core/editor/editor.service";
import { Command, CommandRegistry } from "./core/commands/command-registry";
import { PaletteService } from "./core/commands/palette.service";
import { DocumentService } from "./core/file/document.service";
import { IndexService } from "./core/index/index.service";
import { GitService } from "./core/git/git.service";
import { HealthService } from "./core/index/health.service";
import { SearchService } from "./core/index/search.service";
import { MarkdownService } from "./core/markdown/markdown.service";
import { SettingsService } from "./core/settings/settings.service";
import { SwitcherService } from "./core/switcher/switcher.service";
import { VaultOpsService } from "./core/workspace/vault-ops.service";
import { WorkspaceService } from "./core/workspace/workspace.service";
import { BacklinksComponent } from "./features/backlinks/backlinks.component";
import { PaletteComponent } from "./features/palette/palette.component";
import { SearchComponent } from "./features/search/search.component";
import { SwitcherComponent } from "./features/switcher/switcher.component";
import { SidebarComponent } from "./features/sidebar/sidebar.component";
import { GitComponent } from "./features/git/git.component";
import { StatusBarComponent } from "./features/status-bar/status-bar.component";
import { HealthComponent } from "./features/health/health.component";
import { EditorComponent } from "./features/editor/editor.component";
import { EditorSpikeComponent } from "./features/editor-spike/editor-spike.component";
import { GitSpikeComponent } from "./features/git-spike/git-spike.component";
import { ToolbarComponent } from "./features/toolbar/toolbar.component";
import { ViewerComponent } from "./features/viewer/viewer.component";

@Component({
  selector: "app-root",
  imports: [BacklinksComponent, GitComponent, HealthComponent, StatusBarComponent, EditorComponent, PaletteComponent, SearchComponent, SwitcherComponent, EditorSpikeComponent, GitSpikeComponent, ToolbarComponent, SidebarComponent, ViewerComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
  host: { "(document:keydown)": "onKeydown($event)" },
})
export class AppComponent {
  protected readonly doc = inject(DocumentService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  private readonly markdown = inject(MarkdownService);
  private readonly index = inject(IndexService);
  private readonly ops = inject(VaultOpsService);
  protected readonly editor = inject(EditorService);
  private readonly viewer = viewChild(ViewerComponent);
  protected readonly search = inject(SearchService);
  protected readonly health = inject(HealthService);
  protected readonly git = inject(GitService);
  protected readonly switcher = inject(SwitcherService);
  private readonly commands = inject(CommandRegistry);
  protected readonly palette = inject(PaletteService);

  protected readonly mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";
  protected readonly gitSpike = isDevMode();
  protected readonly toast = signal<string | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly html = computed(() =>
    this.markdown.render(this.doc.content(), {
      filePath: this.doc.path(),
      wikiRoot: this.doc.wikiRoot(),
      math: this.settings.math(),
      vaultFiles: this.workspace.vaultFiles(),
      vaultRoot: this.workspace.vaultRoot(),
    }),
  );

  protected readonly showSidebar = computed(
    () => this.workspace.root() !== null && this.settings.sidebarVisible(),
  );

  protected readonly showBacklinks = computed(
    () => this.workspace.vaultRoot() !== null && this.doc.path() !== null && this.settings.backlinksVisible(),
  );

  protected readonly showSearch = computed(() => this.workspace.vaultRoot() !== null && this.search.visible());

  protected readonly showHealth = computed(() => this.workspace.vaultRoot() !== null && this.health.visible());

  protected readonly showGit = computed(() => this.git.available() && this.git.visible());

  protected readonly showSwitcher = computed(() => this.workspace.vaultRoot() !== null && this.switcher.visible());

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

    this.registerCommands();
    void this.initDesktopIntegration();
  }

  private async initDesktopIntegration(): Promise<void> {
    // Desktop-only listeners must not stop the pending file from opening
    // (on iOS some of them are unavailable).
    try {
      await listen(OPEN_FILE_EVENT, () => this.openPending());
      await listen<string>(FILE_CHANGED_EVENT, (e) => this.doc.onExternalChange(e.payload));
      await this.index.init();
      await listen<string>(MENU_EVENT, (e) => this.commands.execute(e.payload));

      await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths[0]) {
          void this.openPath(event.payload.paths[0]);
        }
      });
    } catch (err) {
      console.warn("desktop integration unavailable", err);
    }

    // A file or folder passed on the command line may already be waiting;
    // otherwise the last opened folder is restored.
    if (!(await this.openPending())) {
      const last = this.settings.lastFolder();
      if (last && (await backend.isDir(last))) await this.run(() => this.workspace.openFolder(last));
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

  protected showToast(message: string): void {
    clearTimeout(this.toastTimer);
    this.toast.set(message);
    this.toastTimer = setTimeout(() => this.toast.set(null), 4000);
  }

  protected async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.showToast(String(err));
    }
  }

  /** Registers the actions of the app; the menu, the shortcuts and the palette run them by id. */
  private registerCommands(): void {
    const inVault = () => this.workspace.vaultRoot() !== null;
    const noteOpen = () => this.doc.path() !== null;
    const commands: Command[] = [
      { id: "command-palette", title: "Command palette", shortcut: "Mod+P", keys: ["Mod+P"], run: () => this.palette.open() },
      { id: "new-note", title: "New note", shortcut: "Mod+N", keys: ["Mod+N"], when: inVault, run: () => this.newNote() },
      { id: "quick-switcher", title: "Quick switcher", shortcut: "Mod+O", keys: ["Mod+O"], when: inVault, run: () => this.switcher.open() },
      { id: "toggle-editor", title: "Toggle editor", shortcut: "Mod+E", when: noteOpen, run: () => this.run(() => this.editor.toggle(this.viewer()?.topLine() ?? null)) },
      { id: "open-file", title: "Open file", shortcut: "Mod+Shift+P", run: () => this.run(() => this.doc.openWithDialog()) },
      { id: "open-folder", title: "Open folder", shortcut: "Mod+Shift+O", run: () => this.run(() => this.workspace.openFolderWithDialog()) },
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
      { id: "back", title: "Back", shortcut: "Mod+[", keys: ["Alt+ArrowLeft"], run: () => this.run(() => this.doc.back()) },
      { id: "forward", title: "Forward", shortcut: "Mod+]", keys: ["Alt+ArrowRight"], run: () => this.run(() => this.doc.forward()) },
      { id: "toggle-sidebar", title: "Toggle sidebar", shortcut: "Mod+B", run: () => this.settings.sidebarVisible.update((v) => !v) },
      { id: "search", title: "Search vault", shortcut: "Mod+Shift+F", keys: ["Mod+Shift+F"], when: inVault, run: () => this.search.openWith() },
      { id: "vault-health", title: "Vault health", when: inVault, run: () => this.health.open() },
      { id: "git-changes", title: "Git changes", when: () => this.git.available(), run: () => this.git.open() },
      { id: "git-sync", title: "Sync with the remote", shortcut: "Mod+Shift+S", keys: ["Mod+Shift+S"], when: () => this.git.available(), run: () => this.git.sync() },
      { id: "toggle-backlinks", title: "Toggle backlinks panel", shortcut: "Mod+Shift+B", when: inVault, run: () => this.settings.backlinksVisible.update((v) => !v) },
      { id: "toggle-math", title: "Toggle LaTeX math", run: () => this.settings.math.update((v) => !v) },
      { id: "cycle-theme", title: "Cycle theme (system, light, dark)", run: () => this.settings.cycleTheme() },
      { id: "zoom-in", title: "Zoom in", shortcut: "Mod+=", run: () => this.settings.zoomIn() },
      { id: "zoom-out", title: "Zoom out", shortcut: "Mod+-", run: () => this.settings.zoomOut() },
      { id: "zoom-reset", title: "Actual size", shortcut: "Mod+0", run: () => this.settings.resetZoom() },
    ];
    for (const command of commands) this.commands.register(command);
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
    const command = this.commands.findByKey(event);
    if (command && this.commands.execute(command.id)) event.preventDefault();
  }
}
