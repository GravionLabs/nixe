import { Component, computed, effect, inject, signal } from "@angular/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { FILE_CHANGED_EVENT, MENU_EVENT, OPEN_FILE_EVENT, STDIN_FILE_SUFFIX, backend } from "./core/file/backend";
import { DocumentService } from "./core/file/document.service";
import { MarkdownService } from "./core/markdown/markdown.service";
import { SettingsService } from "./core/settings/settings.service";
import { WorkspaceService } from "./core/workspace/workspace.service";
import { SidebarComponent } from "./features/sidebar/sidebar.component";
import { ToolbarComponent } from "./features/toolbar/toolbar.component";
import { ViewerComponent } from "./features/viewer/viewer.component";

@Component({
  selector: "app-root",
  imports: [ToolbarComponent, SidebarComponent, ViewerComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
  host: { "(document:keydown)": "onKeydown($event)" },
})
export class AppComponent {
  protected readonly doc = inject(DocumentService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  private readonly markdown = inject(MarkdownService);

  protected readonly mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";
  protected readonly toast = signal<string | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly html = computed(() =>
    this.markdown.render(this.doc.content(), {
      filePath: this.doc.path(),
      wikiRoot: this.doc.wikiRoot(),
      math: this.settings.math(),
    }),
  );

  protected readonly showSidebar = computed(
    () => this.workspace.root() !== null && this.settings.sidebarVisible(),
  );

  constructor() {
    effect(() => {
      const name = this.doc.path()?.endsWith(STDIN_FILE_SUFFIX) ? "stdin" : this.doc.fileName();
      void getCurrentWindow().setTitle(name ? `${name} – Nixe` : "Nixe");
    });

    // Keep the tree in sync with navigation via links and history.
    effect(() => {
      const path = this.doc.path();
      if (path) void this.workspace.reveal(path);
    });

    void this.initDesktopIntegration();
  }

  private async initDesktopIntegration(): Promise<void> {
    await listen(OPEN_FILE_EVENT, () => this.openPending());
    await listen<string>(FILE_CHANGED_EVENT, (e) => this.doc.onExternalChange(e.payload));
    await listen<string>(MENU_EVENT, (e) => this.onMenu(e.payload));

    await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths[0]) {
        void this.openPath(event.payload.paths[0]);
      }
    });

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

  private onMenu(id: string): void {
    const actions: Record<string, () => unknown> = {
      "open-file": () => this.run(() => this.doc.openWithDialog()),
      "open-folder": () => this.run(() => this.workspace.openFolderWithDialog()),
      reload: () => this.run(async () => {
        await this.doc.reload();
        await this.workspace.refresh();
      }),
      back: () => this.run(() => this.doc.back()),
      forward: () => this.run(() => this.doc.forward()),
      "toggle-sidebar": () => this.settings.sidebarVisible.update((v) => !v),
      "toggle-math": () => this.settings.math.update((v) => !v),
      "cycle-theme": () => this.settings.cycleTheme(),
      "zoom-in": () => this.settings.zoomIn(),
      "zoom-out": () => this.settings.zoomOut(),
      "zoom-reset": () => this.settings.resetZoom(),
    };
    actions[id]?.();
  }

  /** Alt+←/→ as additional history shortcuts (menu accelerators cover the rest). */
  protected onKeydown(event: KeyboardEvent): void {
    if (!event.altKey) return;
    if (event.key === "ArrowLeft") void this.run(() => this.doc.back());
    else if (event.key === "ArrowRight") void this.run(() => this.doc.forward());
    else return;
    event.preventDefault();
  }
}
