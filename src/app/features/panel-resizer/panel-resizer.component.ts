import { Component, Input, output } from "@angular/core";

import { GRAB_WIDTH, MIN_PANEL_WIDTH, clampPanelWidth, maxPanelWidth, widthAfterKey } from "../../core/panel/panel-width";

/** The left edge of the right panel: drag it or use the arrow keys to change the width. */
@Component({
  selector: "app-panel-resizer",
  template: "",
  host: {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize panel",
    tabindex: "0",
    "[attr.aria-valuenow]": "width",
    "[attr.aria-valuemin]": "min",
    "[attr.aria-valuemax]": "max()",
    "[style.width.px]": "grab",
    "(pointerdown)": "start($event)",
    "(pointermove)": "move($event)",
    "(pointerup)": "end($event)",
    "(pointercancel)": "end($event)",
    "(keydown)": "key($event)",
  },
  styles: `
    :host {
      position: absolute;
      inset-block: 0;
      inset-inline-start: 0;
      z-index: 2;
      cursor: col-resize;
      touch-action: none;
    }
    :host(:hover),
    :host(:focus-visible),
    :host(.dragging) {
      background: var(--h-primary-color);
      outline: none;
    }
  `,
})
export class PanelResizerComponent {
  // Decorator inputs: signal inputs are not registered when the specs run under the JIT compiler.
  @Input() width = 0;
  @Input() windowWidth = 0;
  @Input() sidebarWidth = 0;
  readonly widthChange = output<number>();

  protected readonly grab = GRAB_WIDTH;
  protected readonly min = MIN_PANEL_WIDTH;
  protected readonly max = () => maxPanelWidth(this.windowWidth, this.sidebarWidth);

  private drag: { x: number; width: number } | null = null;

  protected start(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.drag = { x: event.clientX, width: this.width };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    (event.target as HTMLElement).classList.add("dragging");
    event.preventDefault();
  }

  protected move(event: PointerEvent): void {
    if (!this.drag) return;
    // The panel sits at the right edge: dragging left makes it wider.
    this.widthChange.emit(clampPanelWidth(this.drag.width + (this.drag.x - event.clientX), this.windowWidth, this.sidebarWidth));
  }

  protected end(event: PointerEvent): void {
    this.drag = null;
    (event.target as HTMLElement).classList.remove("dragging");
  }

  protected key(event: KeyboardEvent): void {
    const next = widthAfterKey(event.key, event.shiftKey, this.width, this.windowWidth, this.sidebarWidth);
    if (next === null) return;
    event.preventDefault();
    this.widthChange.emit(next);
  }
}
