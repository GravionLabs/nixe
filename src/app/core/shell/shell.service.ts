import { Injectable, computed, inject } from "@angular/core";
import type { HxActivityBarItem } from "@gravionlabs/helix-desktop";

import { CommandRegistry, formatShortcut } from "../commands/command-registry";
import { GitService } from "../git/git.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import type { NixeView, ViewContext } from "./views";
import { availableViews, findView, isSidebarView, resolveView } from "./views";

/** The activity bar and the sidebar: one active view, shown or collapsed. */
@Injectable({ providedIn: "root" })
export class ShellService {
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly git = inject(GitService);
  private readonly commands = inject(CommandRegistry);

  constructor() {
    const inVault = () => this.workspace.vaultRoot() !== null;
    this.commands.register({
      id: "toggle-sidebar",
      title: "Toggle sidebar",
      shortcut: "Mod+B",
      run: () => this.toggleSidebar(),
    });
    this.commands.register({
      id: "show-files",
      title: "Show files",
      run: () => this.show("files"),
    });
    this.commands.register({
      id: "search",
      title: "Search vault",
      shortcut: "Mod+Shift+F",
      keys: ["Mod+Shift+F"],
      when: inVault,
      run: () => this.show("search"),
    });
    this.commands.register({
      id: "note-history",
      title: "Note history",
      when: () => this.git.available(),
      run: () => this.show("history"),
    });
    this.commands.register({
      id: "git-changes",
      title: "Git changes",
      when: () => this.git.available(),
      run: () => this.show("git"),
    });
  }

  private readonly context = computed<ViewContext>(() => ({
    vault: this.workspace.vaultRoot() !== null,
    git: this.git.available(),
  }));

  /** The view of the sidebar: the stored one, or the files when it is not available. */
  readonly activeView = computed(() => resolveView(this.settings.activeView(), this.context()));
  readonly collapsed = computed(() => !this.settings.sidebarVisible());
  /** The view the sidebar shows now; null while it is collapsed or no folder is open. */
  readonly shownView = computed(() =>
    this.collapsed() || this.workspace.root() === null ? null : this.activeView(),
  );

  /** The items of the activity bar. */
  readonly items = computed<HxActivityBarItem[]>(() =>
    availableViews(this.context()).map((view) => ({
      id: view.id,
      label: this.tooltip(view),
      icon: view.icon,
      position: view.position,
      kind: view.kind,
    })),
  );

  /** The name of an item with its shortcut, e.g. `Search (Ctrl+Shift+F)`; the bar shows it as tooltip. */
  private tooltip(view: NixeView): string {
    const id = view.shortcutCommand ?? view.command;
    const command = this.commands.all().find((c) => c.id === id); // all() is reactive: the tooltip follows later registrations
    const shortcut = command ? this.commands.shortcutOf(command) : "";
    return shortcut
      ? `${view.label} (${formatShortcut(shortcut, navigator.userAgent.includes("Mac"))})`
      : view.label;
  }

  /** A click on the activity bar: the active view collapses the sidebar, another view switches to it. */
  select(id: string): void {
    const view = findView(id);
    if (!view) return;
    if (!isSidebarView(id)) {
      if (view.command) this.commands.execute(view.command);
      return;
    }
    if (id === this.activeView() && !this.collapsed()) this.settings.sidebarVisible.set(false);
    else this.show(id);
  }

  /** Makes a view of the sidebar the active one and opens the sidebar. */
  show(id: string): void {
    if (!isSidebarView(id)) return;
    this.settings.activeView.set(id);
    this.settings.sidebarVisible.set(true);
  }

  toggleSidebar(): void {
    this.settings.sidebarVisible.update((v) => !v);
  }
}
