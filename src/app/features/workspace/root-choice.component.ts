import { Component, inject, linkedSignal, output } from "@angular/core";
import { HxButton, HxDialog, HxFieldset, HxRadio } from "@gravionlabs/helix-ui";

import { WorkspacesService } from "../../core/workspace/workspaces.service";

/** Offers the `$Variable` form of a folder added to the workspace, shown with its resolved path. */
@Component({
  selector: "app-root-choice",
  templateUrl: "./root-choice.component.html",
  styleUrl: "./root-choice.component.css",
  imports: [HxButton, HxDialog, HxFieldset, HxRadio],
})
export class RootChoiceComponent {
  protected readonly workspaces = inject(WorkspacesService);
  readonly failed = output<string>();
  /** The chosen `$Variable` template; null for the absolute path, the choice of every new dialog. */
  protected readonly selected = linkedSignal<unknown, string | null>({
    source: () => this.workspaces.rootChoice(),
    computation: () => null,
  });

  protected submit(event: Event): void {
    event.preventDefault();
    void this.choose(this.selected());
  }

  protected async choose(template: string | null): Promise<void> {
    try {
      await this.workspaces.chooseRootForm(template);
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}
