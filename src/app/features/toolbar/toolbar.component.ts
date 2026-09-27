import { Component, computed, inject } from "@angular/core";

import { DocumentService } from "../../core/file/document.service";
import { SettingsService } from "../../core/settings/settings.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

const MOD = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

@Component({
  selector: "app-toolbar",
  templateUrl: "./toolbar.component.html",
  styleUrl: "./toolbar.component.css",
})
export class ToolbarComponent {
  protected readonly doc = inject(DocumentService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  protected readonly mod = MOD;

  protected readonly themeLabel = computed(
    () => ({ system: "System", light: "Light", dark: "Dark" })[this.settings.themeMode()],
  );
}
