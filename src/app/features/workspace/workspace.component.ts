import { NgComponentOutlet } from "@angular/common";
import { Component, ElementRef, inject } from "@angular/core";

import { basename } from "../../core/markdown/paths";
import { MAX_RATIO, MIN_RATIO } from "../../core/tabs/layout";
import { Pane, Tab, TabsService } from "../../core/tabs/tabs.service";
import { PaneComponent } from "./pane.component";

const KEY_STEP = 0.02;

/** The tab bars and panes: one pane, or two side by side with a draggable divider. */
@Component({
  selector: "app-workspace",
  imports: [NgComponentOutlet],
  templateUrl: "./workspace.component.html",
  styleUrl: "./workspace.component.css",
})
export class WorkspaceComponent {
  protected readonly tabs = inject(TabsService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

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
    const path = tab.doc.path();
    return path ? basename(path).replace(/\.(md|markdown|mdown|mkd)$/i, "") : "New tab";
  }

  protected closeTab(event: Event, pane: Pane, tab: Tab): void {
    event.stopPropagation();
    this.tabs.closeTab(pane.id, tab.id);
  }

  protected middleClose(event: MouseEvent, pane: Pane, tab: Tab): void {
    if (event.button !== 1) return;
    event.preventDefault();
    this.tabs.closeTab(pane.id, tab.id);
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
