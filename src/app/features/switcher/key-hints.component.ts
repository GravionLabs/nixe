import { Component, input } from "@angular/core";

export interface KeyHint {
  keys: string;
  label: string;
}

/** True on macOS, where the modifier key is Cmd. */
export const isMac = (): boolean => navigator.userAgent.includes("Mac");

/** The modifier key as written on this platform. */
export const modKey = (): string => (isMac() ? "⌘" : "Ctrl");

/** Footer of the switcher and the palette: the keys of the dialog. */
@Component({
  selector: "app-key-hints",
  templateUrl: "./key-hints.component.html",
  styles: `
    :host {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 14px;
      padding: 6px 14px;
      border-top: 1px solid var(--h-content-border-color);
      color: var(--h-text-muted-color);
      font-size: 11px;
    }
    kbd {
      padding: 0 4px;
      border: 1px solid var(--h-content-border-color);
      border-radius: 3px;
      font: inherit;
    }
  `,
})
export class KeyHintsComponent {
  readonly hints = input.required<readonly KeyHint[]>();
}
