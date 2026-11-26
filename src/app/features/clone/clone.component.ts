import { Component, inject } from "@angular/core";
import {
  HxButton,
  HxDialog,
  HxField,
  HxInput,
  HxInputGroup,
  HxMessage,
  HxProgressBar,
} from "@gravionlabs/helix-ui";

import { CloneService } from "../../core/git/clone.service";
import { GitService } from "../../core/git/git.service";

/** Dialog of `File → Clone vault…`: URL, target folder, progress and the token prompt. */
@Component({
  selector: "app-clone",
  templateUrl: "./clone.component.html",
  styleUrl: "./clone.component.css",
  imports: [HxButton, HxDialog, HxField, HxInput, HxInputGroup, HxMessage, HxProgressBar],
})
export class CloneComponent {
  protected readonly clone = inject(CloneService);
  protected readonly git = inject(GitService);

  /** Escape, the close button or the mask; also fires when the dialog is destroyed after the service closed it. */
  protected onHidden(): void {
    if (this.clone.visible()) void this.clone.close();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.clone.start();
  }

  protected async chooseFolder(): Promise<void> {
    try {
      await this.clone.chooseFolder();
    } catch (err) {
      this.clone.error.set(String(err));
    }
  }

  protected async saveToken(input: HTMLInputElement): Promise<void> {
    try {
      await this.git.saveToken(input.value);
    } catch (err) {
      this.clone.error.set(String(err));
    }
  }
}
