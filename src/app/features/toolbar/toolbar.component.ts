import { Component, inject } from "@angular/core";
import { HxAppToolbar } from "@gravionlabs/helix-desktop";

import { CommandRegistry } from "../../core/commands/command-registry";
import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { SettingsService } from "../../core/settings/settings.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

const MOD = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

/**
 * The slim bar of the open note: back and forward, the title, the edit toggle, outline and backlinks.
 * Everything else (sidebar, open, zoom, version, LaTeX, theme) lives in the activity bar, the status
 * bar, the settings page and the command palette.
 */
@Component({
  selector: "app-toolbar",
  imports: [HxAppToolbar],
  templateUrl: "./toolbar.component.html",
  styleUrl: "./toolbar.component.css",
})
export class ToolbarComponent {
  protected readonly doc = inject(DocumentService);
  protected readonly workspace = inject(WorkspaceService);
  protected readonly settings = inject(SettingsService);
  protected readonly editor = inject(EditorService);
  private readonly commands = inject(CommandRegistry);
  protected readonly mod = MOD;

  /** Runs the same command as the shortcut and the palette entry. */
  protected run(id: string): void {
    this.commands.execute(id);
  }
}
