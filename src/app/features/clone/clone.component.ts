import { Component, computed, inject, signal } from "@angular/core";
import { FormField, disabled, form, validate } from "@angular/forms/signals";
import {
  HxButton,
  HxDialog,
  HxField,
  HxInput,
  HxInputGroup,
  HxMessage,
  HxProgressBar,
} from "@gravionlabs/helix-ui";

import { CloneService, isCloneUrl } from "../../core/git/clone.service";
import { GitService } from "../../core/git/git.service";
import { SettingsService } from "../../core/settings/settings.service";

/** Dialog of `File → Clone vault…`: URL, target folder, progress and the token prompt. */
@Component({
  selector: "app-clone",
  templateUrl: "./clone.component.html",
  styleUrl: "./clone.component.css",
  imports: [
    FormField,
    HxButton,
    HxDialog,
    HxField,
    HxInput,
    HxInputGroup,
    HxMessage,
    HxProgressBar,
  ],
})
export class CloneComponent {
  protected readonly clone = inject(CloneService);
  protected readonly git = inject(GitService);
  private readonly settings = inject(SettingsService);

  /** The hosts a URL may name: github.com and the configured GitHub Enterprise host. */
  private readonly hosts = computed(() => {
    const extra = this.settings.gitEnterpriseHost().trim();
    return extra && extra.toLowerCase() !== "github.com" ? `github.com or ${extra}` : "github.com";
  });
  protected readonly urlHint = computed(
    () => `HTTPS only: https://<host>/<owner>/<repository>, with ${this.hosts()} as host`,
  );
  protected readonly urlField = form(this.clone.url, (url) => {
    disabled(url, () => this.clone.cloning());
    validate(url, ({ value }) =>
      isCloneUrl(value(), this.settings.gitEnterpriseHost())
        ? undefined
        : { kind: "cloneUrl", message: `Enter an HTTPS URL of ${this.hosts()}` },
    );
  });

  /** The path picker is not a form field: it shows its error itself, once a submit found it empty. */
  private readonly submitted = signal(false);
  protected readonly folderError = computed(() =>
    this.submitted() && !this.clone.parent() ? "Choose a target folder" : null,
  );

  /** Escape, the close button or the mask; also fires when the dialog is destroyed after the service closed it. */
  protected onHidden(): void {
    if (this.clone.visible()) void this.clone.close();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    this.submitted.set(true);
    this.urlField().markAsTouched();
    // The service starts nothing while the form is incomplete.
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
