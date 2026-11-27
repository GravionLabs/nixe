import { Component, effect, inject, output, signal, untracked } from "@angular/core";
import { HxButton, HxList, HxListRow } from "@gravionlabs/helix-ui";

import type { Backlink, UnlinkedMention } from "../../core/file/backend";
import type { OutgoingLink } from "../../core/index/backlinks.service";
import { BacklinksService } from "../../core/index/backlinks.service";
import { joinPath } from "../../core/markdown/paths";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** Right-hand panel: notes linking to the open note, and the links going out of it. */
@Component({
  selector: "app-backlinks",
  imports: [HxList, HxListRow, HxButton],
  templateUrl: "./backlinks.component.html",
  styleUrl: "./backlinks.component.css",
})
export class BacklinksComponent {
  protected readonly links = inject(BacklinksService);
  private readonly workspace = inject(WorkspaceService);
  private readonly tabs = inject(TabsService);
  private readonly preview = inject(LinkPreviewService);

  readonly failed = output<string>();

  /** The section of unlinked mentions starts collapsed: it is read from the index only when opened. */
  protected readonly unlinkedOpen = signal(false);

  constructor() {
    effect(() => {
      this.links.key();
      untracked(() => void this.links.refresh());
    });
    effect(() => {
      this.links.key();
      if (this.unlinkedOpen()) untracked(() => void this.links.loadUnlinked());
    });
  }

  protected toggleUnlinked(): void {
    this.unlinkedOpen.update((open) => !open);
  }

  protected openMention(mention: UnlinkedMention, event?: MouseEvent): Promise<void> {
    return this.open(mention.source, mention.line, null, event);
  }

  protected async linkMention(mention: UnlinkedMention): Promise<void> {
    try {
      await this.links.linkMention(mention);
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  protected openBacklink(link: Backlink, event?: MouseEvent): Promise<void> {
    return this.open(link.source, link.line, link.heading, event);
  }

  protected openOutgoing(link: OutgoingLink, event?: MouseEvent): Promise<void> {
    const target = link.resolved;
    return target ? this.open(target, null, link.heading, event) : Promise.resolve();
  }

  /** Preview of the note of a row on hover; `heading` narrows it to that section. */
  protected hover(event: MouseEvent, rel: string, heading: string | null = null): void {
    const target = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.preview.hover(heading ? `${rel}#${heading}` : rel, target, event.metaKey || event.ctrlKey);
  }

  protected leave(): void {
    this.preview.leave();
  }

  private async open(
    rel: string,
    line: number | null,
    anchor: string | null,
    event?: MouseEvent,
  ): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    try {
      const options = { line, anchor: line === null ? anchor : null };
      if (event && (event.metaKey || event.ctrlKey))
        await this.tabs.openInNewTab(joinPath(root, rel), options);
      else if (event?.type === "dblclick") await this.tabs.openPinned(joinPath(root, rel), options);
      else await this.tabs.openPreview(joinPath(root, rel), options);
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}
