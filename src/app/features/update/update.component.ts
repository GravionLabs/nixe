import { Component, inject } from "@angular/core";

import { UpdateService } from "../../core/updater/update.service";

/** Dialog of `Check for Updates…`: result, release notes and `Install and restart`. */
@Component({
  selector: "app-update",
  templateUrl: "./update.component.html",
  styleUrl: "./update.component.css",
})
export class UpdateComponent {
  protected readonly updater = inject(UpdateService);
}
