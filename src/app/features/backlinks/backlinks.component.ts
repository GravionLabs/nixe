import { Component, effect, inject, output, untracked } from "@angular/core";

import { Backlink } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { BacklinksService, OutgoingLink } from "../../core/index/backlinks.service";
import { joinPath } from "../../core/markdown/paths";
import { TabsService } from "../../core/tabs/tabs.service";
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
  private readonly tabs = inject(TabsService);

  readonly error = output<string>();

  constructor() {
    effect(() => {
      this.links.key();
      untracked(() => void this.links.refresh());
    });
  }

  protected openBacklink(link: Backlink, event?: MouseEvent): Promise<void> {
    return this.open(link.source, link.line, link.heading, event);
  }

  protected openOutgoing(link: OutgoingLink, event?: MouseEvent): Promise<void> {
    const target = link.resolved;
    return target ? this.open(target, null, link.heading, event) : Promise.resolve();
  }

  private async open(rel: string, line: number | null, anchor: string | null, event?: MouseEvent): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    try {
      const options = { line, anchor: line === null ? anchor : null };
      if (event && (event.metaKey || event.ctrlKey)) await this.tabs.openInNewTab(joinPath(root, rel), options);
      else await this.doc.open(joinPath(root, rel), options);
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}
