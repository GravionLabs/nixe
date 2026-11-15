import { Component, effect, inject, output, untracked } from "@angular/core";

import { Backlink } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { BacklinksService, OutgoingLink } from "../../core/index/backlinks.service";
import { joinPath } from "../../core/markdown/paths";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** Right-hand panel: notes linking to the open note, and the links going out of it. */
@Component({
  selector: "app-backlinks",
  templateUrl: "./backlinks.component.html",
  styleUrl: "./backlinks.component.css",
})
export class BacklinksComponent {
  protected readonly links = inject(BacklinksService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);

  readonly error = output<string>();

  constructor() {
    effect(() => {
      this.links.key();
      untracked(() => void this.links.refresh());
    });
  }

  protected openBacklink(link: Backlink): Promise<void> {
    return this.open(link.source, link.line, link.heading);
  }

  protected openOutgoing(link: OutgoingLink): Promise<void> {
    const target = link.resolved;
    return target ? this.open(target, null, link.heading) : Promise.resolve();
  }

  private async open(rel: string, line: number | null, anchor: string | null): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    try {
      await this.doc.open(joinPath(root, rel), { line, anchor: line === null ? anchor : null });
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}
