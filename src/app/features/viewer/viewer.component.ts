import {
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from "@angular/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import { backend } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { classifyHref, resolveLocalLink } from "../../core/markdown/link-resolver";
import { slugify } from "../../core/markdown/markdown-renderer";
import { MermaidRenderer } from "../../core/markdown/mermaid-renderer";
import { isMarkdownPath } from "../../core/markdown/paths";

@Component({
  selector: "app-viewer",
  template: `<article #content class="markdown-body" (click)="onClick($event)"></article>`,
  styleUrl: "./viewer.component.css",
})
export class ViewerComponent {
  /** Sanitized HTML (see MarkdownService). */
  readonly html = input.required<string>();
  readonly dark = input(false);
  readonly notify = output<string>();

  private readonly doc = inject(DocumentService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly content = viewChild.required<ElementRef<HTMLElement>>("content");
  private readonly mermaid = new MermaidRenderer();
  private renderedPath: string | null = null;

  constructor() {
    effect(() => {
      const el = this.content().nativeElement;
      const html = this.html();
      const dark = this.dark();
      untracked(() => {
        el.innerHTML = html; // already sanitized with DOMPurify
        // A newly opened document starts at the top (external reloads keep the position).
        const path = this.doc.path();
        if (path !== this.renderedPath) {
          this.renderedPath = path;
          this.host.nativeElement.scrollTop = 0;
        }
        this.applyPendingAnchor(false);
        // Diagrams change the layout, so the anchor is applied again afterwards.
        void this.mermaid.render(el, dark).then(() => this.applyPendingAnchor(true));
      });
    });
  }

  async onClick(event: MouseEvent): Promise<void> {
    const link = (event.target as Element).closest("a");
    if (!link) return;
    event.preventDefault();

    const target = classifyHref(link.getAttribute("href"));
    switch (target.kind) {
      case "anchor":
        this.scrollToAnchor(target.anchor);
        break;
      case "external":
        await openUrl(target.url);
        break;
      case "local": {
        const currentFile = this.doc.path();
        if (!currentFile) {
          this.notify.emit("No file is open.");
          return;
        }
        const resolved = await resolveLocalLink(target.path, {
          currentFile,
          wikiRoot: this.doc.wikiRoot() ?? currentFile,
          exists: backend.isFile,
        });
        if (!resolved) {
          this.notify.emit(`File not found: ${target.path}`);
        } else if (isMarkdownPath(resolved)) {
          await this.doc.open(resolved, { anchor: target.anchor }).catch((err) => this.notify.emit(String(err)));
        } else {
          await openPath(resolved);
        }
        break;
      }
    }
  }

  /** `done`: the layout is final (diagrams rendered), so the anchor is consumed. */
  private applyPendingAnchor(done: boolean): void {
    const anchor = this.doc.pendingAnchor();
    if (anchor === null) return;
    if (this.scrollToAnchor(anchor) && done) this.doc.pendingAnchor.set(null);
  }

  /** Accepts exact ids as well as un-slugified heading text (ADO: "#My-Heading"). */
  private scrollToAnchor(anchor: string): boolean {
    const root = this.content().nativeElement;
    const candidates = [anchor, anchor.toLowerCase(), slugify(anchor)];
    for (const id of candidates) {
      const el = root.querySelector(`[id="${CSS.escape(id)}"]`);
      if (el) {
        el.scrollIntoView({ block: "start" });
        return true;
      }
    }
    return false;
  }
}
