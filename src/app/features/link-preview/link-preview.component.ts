import { Component, ElementRef, HostListener, computed, effect, inject, untracked, viewChild } from "@angular/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { backend } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { classifyHref, resolveLocalLink } from "../../core/markdown/link-resolver";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { MermaidRenderer } from "../../core/markdown/mermaid-renderer";
import { isMarkdownPath, joinPath } from "../../core/markdown/paths";
import { parseWikilinkTarget, resolveWikilink } from "../../core/markdown/wikilink-resolver";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { placePopover } from "../../core/preview/preview-core";
import { SettingsService } from "../../core/settings/settings.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

const WIDTH = 440;
const HEIGHT = 320;

/**
 * Popover with the rendered target of a hovered link. It is scrollable and its links work, but it
 * is never focused: a mouse press on it does not move the focus away from the note.
 */
@Component({
  selector: "app-link-preview",
  template: `
    @if (preview.shown(); as shown) {
      <div
        class="link-preview"
        [style.left.px]="place()?.left"
        [style.top.px]="place()?.top"
        [style.bottom.px]="place()?.bottom"
        [style.width.px]="width"
        [style.max-height.px]="height"
        (mouseenter)="preview.keep()"
        (mouseleave)="preview.leave()"
        (mousedown)="$event.preventDefault()"
        (click)="onClick($event)"
      >
        <article #body class="markdown-body"></article>
      </div>
    }
  `,
  styleUrl: "./link-preview.component.css",
})
export class LinkPreviewComponent {
  protected readonly preview = inject(LinkPreviewService);
  private readonly doc = inject(DocumentService);
  private readonly tabs = inject(TabsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly settings = inject(SettingsService);
  private readonly markdown = inject(MarkdownService);
  private readonly mermaid = new MermaidRenderer();
  private readonly body = viewChild<ElementRef<HTMLElement>>("body");

  protected readonly width = WIDTH;
  protected readonly height = HEIGHT;
  protected readonly place = computed(() => {
    const shown = this.preview.shown();
    if (!shown) return null;
    return placePopover(
      shown.anchor,
      { width: WIDTH, height: HEIGHT },
      { width: window.innerWidth, height: window.innerHeight },
    );
  });

  constructor() {
    effect(() => {
      const shown = this.preview.shown();
      const el = this.body()?.nativeElement;
      if (!shown || !el) return;
      untracked(() => {
        el.innerHTML = shown.html; // sanitized by MarkdownService
        void this.markdown
          .expandEmbeds(el, {
            filePath: shown.path,
            wikiRoot: this.doc.wikiRoot(),
            math: this.settings.math(),
            vaultFiles: this.workspace.vaultFiles(),
            vaultRoot: this.workspace.vaultRoot(),
          })
          .catch(() => undefined)
          .then(() => this.mermaid.render(el, this.settings.dark()))
          .catch(() => undefined);
      });
    });
  }

  @HostListener("document:keydown.escape")
  protected onEscape(): void {
    if (this.preview.shown()) this.preview.close();
  }

  protected async onClick(event: MouseEvent): Promise<void> {
    const link = (event.target as Element).closest("a");
    if (!link) return;
    event.preventDefault();
    const newTab = event.metaKey || event.ctrlKey;
    const shown = this.preview.shown();
    const wiki = link.classList.contains("wikilink") ? link.getAttribute("data-target") : null;
    if (wiki !== null) {
      const root = this.workspace.vaultRoot();
      const files = this.workspace.vaultFiles();
      const rel = root && files && parseWikilinkTarget(wiki).note ? resolveWikilink(wiki, files) : null;
      if (!root || !rel || !isMarkdownPath(rel)) return;
      this.preview.close();
      await this.open(joinPath(root, rel), parseWikilinkTarget(wiki).heading, newTab);
      return;
    }
    const href = classifyHref(link.getAttribute("href"));
    if (href.kind === "external") {
      await openUrl(href.url).catch(() => undefined);
    } else if (href.kind === "local" && shown) {
      const resolved = await resolveLocalLink(href.path, {
        currentFile: shown.path,
        wikiRoot: this.doc.wikiRoot() ?? shown.path,
        exists: backend.isFile,
      });
      if (resolved && isMarkdownPath(resolved)) {
        this.preview.close();
        await this.open(resolved, href.anchor, newTab);
      }
    }
  }

  private async open(path: string, anchor: string | null, newTab: boolean): Promise<void> {
    try {
      if (newTab) await this.tabs.openInNewTab(path, { anchor });
      else await this.doc.open(path, { anchor });
    } catch (err) {
      this.tabs.notice.set(String(err));
    }
  }
}
