import { Component, effect, inject, output, untracked } from "@angular/core";

import type { RelatedNote } from "../../core/file/backend";
import { RelatedService } from "../../core/index/related.service";
import { joinPath } from "../../core/markdown/paths";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** Right-hand panel, tab Related: the notes closest to the open note and why. */
@Component({
  selector: "app-related",
  templateUrl: "./related.component.html",
  styleUrl: "./related.component.css",
})
export class RelatedComponent {
  protected readonly related = inject(RelatedService);
  private readonly workspace = inject(WorkspaceService);
  private readonly tabs = inject(TabsService);
  private readonly preview = inject(LinkPreviewService);

  readonly failed = output<string>();

  constructor() {
    effect(() => {
      this.related.key();
      untracked(() => void this.related.refresh());
    });
  }

  protected async open(note: RelatedNote, event?: MouseEvent): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    try {
      if (event && (event.metaKey || event.ctrlKey))
        await this.tabs.openInNewTab(joinPath(root, note.path));
      else if (event?.type === "dblclick") await this.tabs.openPinned(joinPath(root, note.path));
      else await this.tabs.openPreview(joinPath(root, note.path));
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  protected hover(event: MouseEvent, note: RelatedNote): void {
    const target = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.preview.hover(note.path, target, event.metaKey || event.ctrlKey);
  }

  protected leave(): void {
    this.preview.leave();
  }
}
