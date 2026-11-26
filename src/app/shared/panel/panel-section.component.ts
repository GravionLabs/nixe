import { Component, Input, signal } from "@angular/core";
import { HxButton } from "@gravionlabs/helix-ui";

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
  imports: [HxButton],
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
      flex: 1;
      justify-content: flex-start;
      min-width: 0;
    }

    .chevron {
      width: 10px;
      color: var(--h-text-muted-color);
    }

    .title {
      font-weight: 600;
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
