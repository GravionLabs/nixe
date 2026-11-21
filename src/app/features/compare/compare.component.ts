import { Component, computed, inject } from "@angular/core";

import { CompareService } from "../../core/compare/compare.service";
import { diffLines, diffStat } from "../../core/git/line-diff";
import { CURRENT_TAB } from "../../core/tabs/tabs.service";
import { DiffComponent } from "../../shared/diff/diff.component";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";

/** Two versions of a note in the main area: rendered side by side or as a line diff. */
@Component({
  selector: "app-compare",
  imports: [DiffComponent, EmptyStateComponent],
  templateUrl: "./compare.component.html",
  styleUrl: "./compare.component.css",
})
export class CompareComponent {
  private readonly tab = inject(CURRENT_TAB);
  protected readonly compare = inject(CompareService);

  protected readonly input = this.tab.compare;
  protected readonly stat = computed(() => {
    const c = this.input();
    return c ? diffStat(diffLines(c.oldText ?? "", c.newText ?? "")) : { added: 0, removed: 0 };
  });
}
