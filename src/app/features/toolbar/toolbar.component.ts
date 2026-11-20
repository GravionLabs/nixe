import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { HxAppToolbar } from "@gravionlabs/helix-desktop";

import { CommandRegistry } from "../../core/commands/command-registry";
import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { ShellService } from "../../core/shell/shell.service";
import { SettingsService } from "../../core/settings/settings.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { Crumb, breadcrumb } from "./breadcrumb";

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
  private readonly shell = inject(ShellService);
  private readonly ops = inject(VaultOpsService);
  protected readonly mod = MOD;

  readonly error = output<string>();

  /** The path of the note as segments. */
  protected readonly crumbs = computed<Crumb[]>(() =>
    breadcrumb(this.doc.path(), this.workspace.vaultRoot()),
  );
  /** True while the note name is edited in place. */
  protected readonly renaming = signal(false);
  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>("renameInput");
  private renameDone = false;

  constructor() {
    effect(() => {
      const input = this.renameInput()?.nativeElement;
      if (!input) return;
      input.focus();
      const dot = input.value.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    });
    // Another note ends a rename that is still open.
    effect(() => {
      this.doc.path();
      this.renaming.set(false);
    });
  }

  /** Shows the folder in the file tree. */
  protected async revealFolder(dir: string): Promise<void> {
    try {
      this.shell.show("files");
      // The folder itself is expanded too: the path below it leads through it.
      await this.workspace.reveal(`${dir}/.`);
    } catch (err) {
      this.error.emit(String(err));
    }
  }

  protected startRename(): void {
    if (this.doc.path() === null) return;
    this.renameDone = false;
    this.renaming.set(true);
  }

  protected async commitRename(input: HTMLInputElement): Promise<void> {
    if (this.renameDone) return;
    this.renameDone = true;
    const path = this.doc.path();
    this.renaming.set(false);
    if (!path || input.value.trim() === this.crumbs().at(-1)?.label) return;
    try {
      await this.ops.rename(path, input.value);
    } catch (err) {
      this.error.emit(String(err));
    }
  }

  protected cancelRename(): void {
    this.renameDone = true;
    this.renaming.set(false);
  }

  /** Runs the same command as the shortcut and the palette entry. */
  protected run(id: string): void {
    this.commands.execute(id);
  }
}
