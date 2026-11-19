import { Component, computed, inject } from "@angular/core";

import { CommandRegistry } from "../../core/commands/command-registry";
import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { ShellService } from "../../core/shell/shell.service";
import { SettingsService, ZOOM_MAX, ZOOM_MIN } from "../../core/settings/settings.service";
import { UpdateService } from "../../core/updater/update.service";
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
  protected readonly editor = inject(EditorService);
  protected readonly updater = inject(UpdateService);
  protected readonly shell = inject(ShellService);
  private readonly commands = inject(CommandRegistry);
  protected readonly mod = MOD;
  protected readonly zoomMin = ZOOM_MIN;
  protected readonly zoomMax = ZOOM_MAX;

  protected readonly themeLabel = computed(
    () => ({ system: "System", light: "Light", dark: "Dark" })[this.settings.themeMode()],
  );

  /** Runs the same command as the shortcut and the menu entry. */
  protected toggleEditor(): void {
    this.commands.execute("toggle-editor");
  }
}
