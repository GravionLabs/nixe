import { Component, computed, inject, signal } from "@angular/core";
import { HxButton, HxSelectButton } from "@gravionlabs/helix-ui";

import { CompareService } from "../../core/compare/compare.service";
import { diffLines, diffStat } from "../../core/git/line-diff";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import { DiffComponent } from "../../shared/diff/diff.component";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";

/** Two versions of a note in the main area: rendered side by side or as a line diff. */
@Component({
  selector: "app-compare",
  imports: [DiffComponent, EmptyStateComponent, HxButton, HxSelectButton],
  templateUrl: "./compare.component.html",
  styleUrl: "./compare.component.css",
})
export class CompareComponent {
  private readonly tab = inject(CURRENT_TAB);
  private readonly tabs = inject(TabsService);
  protected readonly modes = [
    { label: "Rendered", value: "rendered" },
    { label: "Source", value: "source" },
  ];
  /** The action (Restore) runs. */
  protected readonly busy = signal(false);
  protected readonly compare = inject(CompareService);

  protected readonly input = this.tab.compare;
  protected readonly stat = computed(() => {
    const c = this.input();
    return c ? diffStat(diffLines(c.oldText ?? "", c.newText ?? "")) : { added: 0, removed: 0 };
  });

  /** Runs the action of the view; when it is done the compare tab has nothing left to show. */
  protected async act(): Promise<void> {
    const action = this.input()?.action;
    if (!action || this.busy()) return;
    this.busy.set(true);
    try {
      if (!(await action.run())) return;
      const pane = this.tabs.panes().find((p) => p.tabs.includes(this.tab));
      if (pane) this.tabs.closeTab(pane.id, this.tab.id);
    } finally {
      this.busy.set(false);
    }
  }
}
