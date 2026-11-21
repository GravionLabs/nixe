import { Component, inject } from "@angular/core";

import type { ReviewBranch } from "../../core/file/backend";
import { ReviewService } from "../../core/git/review.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";
import { PanelSectionComponent } from "../../shared/panel/panel-section.component";
import { formatCommitTime } from "../history/history.component";

/**
 * The suggestions that wait for review as cards (#108, #322). The review itself runs in a tab of
 * the main area (`ReviewTabComponent`).
 */
@Component({
  selector: "app-review",
  imports: [PanelSectionComponent, EmptyStateComponent],
  templateUrl: "./review.component.html",
  styleUrl: "./review.component.css",
})
export class ReviewComponent {
  protected readonly review = inject(ReviewService);
  private readonly tabs = inject(TabsService);

  protected readonly time = formatCommitTime;

  /** Opens the suggestion in a review tab of the main area. */
  protected open(branch: ReviewBranch): void {
    void this.review.view(branch);
    this.tabs.openView("review");
  }
}
