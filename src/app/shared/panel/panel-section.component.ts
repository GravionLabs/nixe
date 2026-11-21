import { Component, Input, signal } from "@angular/core";

const KEY_PREFIX = "nixe.panel-section.";

function stored(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  try {
    const value = localStorage.getItem(KEY_PREFIX + key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

/**
 * A collapsible section of a side panel: title, count and actions (`<… panelActions>`) in the head.
 * With a `storageKey` its open state survives a restart.
 */
@Component({
  selector: "app-panel-section",
  templateUrl: "./panel-section.component.html",
  styles: `
    :host {
      display: block;
    }

    .head {
      display: flex;
      align-items: center;
      padding-right: 12px;
    }

    .toggle {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 6px 12px;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }

    .toggle:hover {
      background: var(--h-surface-hover);
    }

    .chevron {
      width: 10px;
      color: var(--h-text-muted-color);
    }

    .count {
      color: var(--h-text-muted-color);
      font-weight: 400;
    }

    .actions {
      display: inline-flex;
      gap: 4px;
    }
  `,
})
export class PanelSectionComponent {
  @Input({ required: true }) title!: string;
  @Input() count?: number;
  @Input() storageKey?: string;
  @Input() initiallyOpen = true;

  private readonly toggled = signal<boolean | null>(null);
  protected get open(): boolean {
    return this.toggled() ?? stored(this.storageKey, this.initiallyOpen);
  }

  protected toggle(): void {
    const next = !this.open;
    this.toggled.set(next);
    const key = this.storageKey;
    if (!key) return;
    try {
      localStorage.setItem(KEY_PREFIX + key, next ? "1" : "0");
    } catch {
      // The state then lasts for this session only.
    }
  }
}
