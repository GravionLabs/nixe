import { NgComponentOutlet } from "@angular/common";
import { Component, ElementRef, computed, inject } from "@angular/core";
import type { HxTabBarItem, HxTabBarMenuItem, HxTabBarReceive } from "@gravionlabs/helix-ui";
import { HxButton, HxTabBar, HxTooltip } from "@gravionlabs/helix-ui";

import { ShortcutService } from "../../core/commands/shortcut.service";
import { basename } from "../../core/markdown/paths";
import type { TabView } from "../../core/tabs/layout";
import { MAX_RATIO, MIN_RATIO } from "../../core/tabs/layout";
import type { Pane, Tab } from "../../core/tabs/tabs.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { PaneComponent } from "./pane.component";

const KEY_STEP = 0.02;
const VIEW_TITLES: Record<Exclude<TabView, "compare">, string> = {
  settings: "Settings",
  health: "Vault health",
};

/** The tab bars and panes: one pane, or two side by side with a draggable divider. */
@Component({
  selector: "app-workspace",
  imports: [NgComponentOutlet, HxButton, HxTabBar, HxTooltip],
  templateUrl: "./workspace.component.html",
  styleUrl: "./workspace.component.css",
})
export class WorkspaceComponent {
  protected readonly tabs = inject(TabsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly shortcuts = inject(ShortcutService);
  /** The tab menu; "Close" shows the shortcut of the close-tab command. */
  protected readonly menu = computed<readonly HxTabBarMenuItem[]>(() => [
    { action: "close", label: "Close", shortcut: this.shortcuts.display("close-tab") },
  ]);
  protected readonly paneType = PaneComponent;
  protected readonly minPercent = MIN_RATIO * 100;
  protected readonly maxPercent = MAX_RATIO * 100;

  protected percent(): number {
    return Math.round(this.tabs.ratio() * 100);
  }

  protected shown(pane: Pane): Tab {
    return pane.tabs.find((t) => t.id === pane.activeId) ?? pane.tabs[0];
  }

  protected title(tab: Tab): string {
    const view = tab.view();
    if (view === "compare")
      return `Compare ${basename(tab.compare()?.path ?? "").replace(/\.(md|markdown|mdown|mkd)$/i, "")}`.trim();
    if (view) return VIEW_TITLES[view];
    const path = tab.doc.path();
    return path ? basename(path).replace(/\.(md|markdown|mdown|mkd)$/i, "") : "New tab";
  }

  protected items(pane: Pane): HxTabBarItem[] {
    return pane.tabs.map((tab) => ({
      id: String(tab.id),
      label: this.title(tab),
      title: tab.doc.path() ?? this.title(tab),
      modified: tab.editor.unsaved(),
      missing: tab.doc.missing(),
    }));
  }

  protected activate(pane: Pane, id: string | null): void {
    if (id !== null) this.tabs.activate(pane.id, Number(id));
  }

  protected closeTab(pane: Pane, id: string): void {
    this.tabs.closeTab(pane.id, Number(id));
  }

  protected onMenu(pane: Pane, event: { id: string; action: string }): void {
    if (event.action === "close") this.closeTab(pane, event.id);
  }

  protected receive(pane: Pane, event: HxTabBarReceive): void {
    const from = Number(event.from.replace("pane-", ""));
    this.tabs.moveTabToPane(from, Number(event.id), pane.id, event.index);
  }

  protected addTab(pane: Pane): void {
    this.tabs.focusPane(pane.id);
    try {
      this.tabs.newTab();
    } catch (err) {
      this.tabs.notice.set(String(err));
    }
  }

  protected startDrag(event: PointerEvent): void {
    const divider = event.currentTarget as HTMLElement;
    divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  protected drag(event: PointerEvent): void {
    const divider = event.currentTarget as HTMLElement;
    if (!divider.hasPointerCapture(event.pointerId)) return;
    const rect = this.host.nativeElement.getBoundingClientRect();
    if (rect.width > 0) this.tabs.setRatio((event.clientX - rect.left) / rect.width);
  }

  protected dividerKey(event: KeyboardEvent): void {
    const step = event.key === "ArrowLeft" ? -KEY_STEP : event.key === "ArrowRight" ? KEY_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    this.tabs.setRatio(this.tabs.ratio() + step);
  }
}
