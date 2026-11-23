import { Component, inject, output } from "@angular/core";
import { HxDialog } from "@gravionlabs/helix-ui";

import { WorkspacesService } from "../../core/workspace/workspaces.service";

/** Offers the `$Variable` form of a folder added to the workspace, shown with its resolved path. */
@Component({
  selector: "app-root-choice",
  templateUrl: "./root-choice.component.html",
  styleUrl: "./root-choice.component.css",
  imports: [HxDialog],
})
export class RootChoiceComponent {
  protected readonly workspaces = inject(WorkspacesService);
  readonly failed = output<string>();

  protected async choose(template: string | null): Promise<void> {
    try {
      await this.workspaces.chooseRootForm(template);
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}
