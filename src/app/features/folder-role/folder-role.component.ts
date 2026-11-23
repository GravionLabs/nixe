import { Component, computed, inject, signal } from "@angular/core";
import { HxDialog } from "@gravionlabs/helix-ui";

import { basename } from "../../core/markdown/paths";
import {
  FolderRolesService,
  STANDARD_FOLDER_ROLES,
} from "../../core/workspace/folder-roles.service";

/** Dialog "Set folder role…": a standard role from a list or an own name, and a description. */
@Component({
  selector: "app-folder-role",
  templateUrl: "./folder-role.component.html",
  styleUrl: "./folder-role.component.css",
  imports: [HxDialog],
})
export class FolderRoleComponent {
  protected readonly roles = inject(FolderRolesService);
  protected readonly standard = STANDARD_FOLDER_ROLES;
  protected readonly dialog = computed(() => this.roles.dialog());
  protected readonly name = signal(this.roles.dialog()?.current?.role ?? "");
  protected readonly description = signal(this.roles.dialog()?.current?.description ?? "");
  protected readonly error = signal("");
  protected readonly basename = basename;

  /** An own role needs a description; a standard one does not. */
  protected readonly needsDescription = computed(
    () =>
      this.name().trim() !== "" &&
      !(STANDARD_FOLDER_ROLES as readonly string[]).includes(this.name().trim()),
  );

  protected onHidden(): void {
    this.roles.closeDialog();
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const dialog = this.dialog();
    if (!dialog) return;
    try {
      await this.roles.set(dialog.rel, this.name(), this.description());
      this.roles.closeDialog();
    } catch (err) {
      this.error.set(String(err).replace(/^Error: /, ""));
    }
  }

  protected async remove(): Promise<void> {
    const dialog = this.dialog();
    if (!dialog) return;
    try {
      await this.roles.remove(dialog.rel);
      this.roles.closeDialog();
    } catch (err) {
      this.error.set(String(err).replace(/^Error: /, ""));
    }
  }
}
