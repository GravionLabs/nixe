import { Injectable, inject, signal } from "@angular/core";

import { TabsService } from "../tabs/tabs.service";
import type { CompareInput, CompareMode } from "./compare";

const MODE_KEY = "nixe.compare-mode";

function storedMode(): CompareMode {
  try {
    return localStorage.getItem(MODE_KEY) === "source" ? "source" : "rendered";
  } catch {
    return "rendered";
  }
}

/** Opens two versions of a note in a tab of the main area and remembers the chosen mode. */
@Injectable({ providedIn: "root" })
export class CompareService {
  private readonly tabs = inject(TabsService);

  readonly mode = signal<CompareMode>(storedMode());

  /** Shows the versions; the tab already comparing the same note takes them instead of a new tab. */
  open(input: CompareInput): void {
    for (const pane of this.tabs.panes()) {
      const found = pane.tabs.find(
        (t) => t.view() === "compare" && t.compare()?.path === input.path,
      );
      if (found) {
        found.compare.set(input);
        this.tabs.activate(pane.id, found.id);
        return;
      }
    }
    const tab = this.tabs.newTab();
    tab.compare.set(input);
    tab.view.set("compare");
  }

  setMode(mode: CompareMode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // The mode is then kept for this session only.
    }
  }
}
