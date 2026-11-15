import {
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import { backend } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { classifyHref, resolveLocalLink } from "../../core/markdown/link-resolver";
import { slugify } from "../../core/markdown/markdown-renderer";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { MermaidRenderer } from "../../core/markdown/mermaid-renderer";
import { isMarkdownPath, joinPath } from "../../core/markdown/paths";
import { parseWikilinkTarget, resolveWikilink } from "../../core/markdown/wikilink-resolver";
import { SearchService } from "../../core/index/search.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { SettingsService } from "../../core/settings/settings.service";

const DIALOG_ZOOM_MIN = 0.25;
const DIALOG_ZOOM_MAX = 6;
const DIALOG_ZOOM_STEP = 1.1;

@Component({
  selector: "app-viewer",
  template: `
    <article
      #content
      class="markdown-body"
      [style.zoom.%]="settings.zoom()"
      (click)="onClick($event)"
      (wheel)="onWheel($event)"
    ></article>

    <div
      class="diagram-dialog-backdrop"
      [class.open]="dialogOpen()"
      (click)="closeDiagram()"
      (wheel)="onDialogWheel($event)"
    >
      <div class="diagram-dialog" (click)="$event.stopPropagation()">
        <div class="diagram-dialog-toolbar">
          <button type="button" (click)="dialogZoomOut()" title="Zoom out" aria-label="Zoom out">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35M8 11h6" /></svg>
          </button>
          <button type="button" class="zoom-level" (click)="resetDialogZoom()" title="Reset zoom">
            {{ dialogZoomPercent() }}%
          </button>
          <button type="button" (click)="dialogZoomIn()" title="Zoom in" aria-label="Zoom in">
            <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.35-4.35M11 8v6M8 11h6" /></svg>
          </button>
        </div>
        <button type="button" class="close" (click)="closeDiagram()" aria-label="Close">✕</button>
        <div class="diagram-dialog-viewport">
          <div #dialogContent class="diagram-dialog-content"></div>
        </div>
      </div>
    </div>
  `,
  styleUrl: "./viewer.component.css",
})
export class ViewerComponent {
  /** Sanitized HTML (see MarkdownService). */
  readonly html = input.required<string>();
  readonly dark = input(false);
  readonly notify = output<string>();

  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly search = inject(SearchService);
  protected readonly settings = inject(SettingsService);
  private readonly markdown = inject(MarkdownService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly content = viewChild.required<ElementRef<HTMLElement>>("content");
  /** Always mounted (visibility toggled via CSS), so it's available as soon as a diagram is clicked. */
  private readonly dialogContent = viewChild<ElementRef<HTMLElement>>("dialogContent");
  private readonly mermaid = new MermaidRenderer();
  private renderedPath: string | null = null;

  protected readonly dialogOpen = signal(false);
  protected readonly dialogZoom = signal(1);
  protected readonly dialogZoomPercent = computed(() => Math.round(this.dialogZoom() * 100));
  /** The dialog's diagram, in its own SVG user units (from its viewBox) at zoom 1. */
  private dialogNaturalSize: { width: number; height: number } | null = null;

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
        this.applyPendingLine(false);
        // Diagrams change the layout, so the anchor is applied again afterwards.
        // Embedded notes are loaded first so diagrams inside them render too.
        void this.markdown
          .expandEmbeds(el, {
            filePath: path,
            wikiRoot: this.doc.wikiRoot(),
            math: this.settings.math(),
            vaultFiles: this.workspace.vaultFiles(),
            vaultRoot: this.workspace.vaultRoot(),
          })
          .catch(() => undefined)
          .then(() => this.mermaid.render(el, dark))
          .then(() => {
            this.applyPendingAnchor(true);
            this.applyPendingLine(true);
          });
      });
    });

    // Opening a line of the note that is already shown renders nothing new, so scroll here.
    effect(() => {
      const line = this.doc.pendingLine();
      if (line === null) return;
      untracked(() => {
        if (this.renderedPath === this.doc.path() && this.scrollToLine(line)) this.doc.pendingLine.set(null);
      });
    });
  }

  /** Ctrl/Cmd + wheel always zooms the whole document. */
  onWheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    if (event.deltaY < 0) this.settings.zoomIn();
    else this.settings.zoomOut();
  }

  /** Plain wheel zooms the diagram dialog — it has nothing else to scroll. */
  onDialogWheel(event: WheelEvent): void {
    event.preventDefault();
    this.stepDialogZoom(event.deltaY < 0 ? DIALOG_ZOOM_STEP : 1 / DIALOG_ZOOM_STEP);
  }

  protected dialogZoomIn(): void {
    this.stepDialogZoom(DIALOG_ZOOM_STEP);
  }

  protected dialogZoomOut(): void {
    this.stepDialogZoom(1 / DIALOG_ZOOM_STEP);
  }

  protected resetDialogZoom(): void {
    this.dialogZoom.set(1);
    this.applyDialogZoom();
  }

  private stepDialogZoom(factor: number): void {
    this.dialogZoom.update((z) => Math.min(DIALOG_ZOOM_MAX, Math.max(DIALOG_ZOOM_MIN, z * factor)));
    this.applyDialogZoom();
  }

  /**
   * Resizes the SVG itself (from its intrinsic viewBox size) rather than using a CSS
   * transform, so the browser re-renders the vector paths at the target size instead
   * of stretching an already-rasterized bitmap — the latter looks blurry when zoomed in.
   */
  private applyDialogZoom(): void {
    const svg = this.dialogContent()?.nativeElement.querySelector("svg");
    const size = this.dialogNaturalSize;
    if (!svg || !size) return;
    const zoom = this.dialogZoom();
    svg.style.maxWidth = "none";
    svg.style.width = `${size.width * zoom}px`;
    svg.style.height = `${size.height * zoom}px`;
  }

  closeDiagram(): void {
    this.dialogOpen.set(false);
    document.removeEventListener("keydown", this.onDialogKeydown);
  }

  private readonly onDialogKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.closeDiagram();
  };

  async onClick(event: MouseEvent): Promise<void> {
    const target = event.target as Element;

    const diagram = target.closest<HTMLElement>(".mermaid-diagram");
    if (diagram && !target.closest("a")) {
      const svg = diagram.querySelector("svg");
      const container = this.dialogContent()?.nativeElement;
      if (svg && container) {
        container.innerHTML = svg.outerHTML;
        const clone = container.querySelector<SVGSVGElement>("svg");
        const viewBox = clone?.viewBox.baseVal;
        this.dialogNaturalSize =
          viewBox && viewBox.width && viewBox.height
            ? { width: viewBox.width, height: viewBox.height }
            : { width: clone?.clientWidth || 300, height: clone?.clientHeight || 150 };
        this.dialogZoom.set(1);
        this.applyDialogZoom();
        this.dialogOpen.set(true);
        document.addEventListener("keydown", this.onDialogKeydown);
      }
      return;
    }

    const calloutTitle = target.closest<HTMLElement>(".callout-title");
    const callout = calloutTitle?.parentElement;
    if (calloutTitle && callout?.classList.contains("is-collapsible") && !target.closest("a")) {
      const collapsed = callout.classList.toggle("is-collapsed");
      calloutTitle.setAttribute("aria-expanded", String(!collapsed));
      return;
    }

    const link = target.closest("a");
    if (!link) return;
    event.preventDefault();
    if (link.classList.contains("tag")) {
      const name = link.getAttribute("data-tag") ?? link.textContent?.replace(/^#/, "") ?? "";
      if (name) this.search.openWith(`tag:#${name}`);
      return;
    }

    const wikiTarget = link.classList.contains("wikilink") ? link.getAttribute("data-target") : null;
    if (wikiTarget !== null) {
      await this.openWikilink(wikiTarget);
      return;
    }

    const href = classifyHref(link.getAttribute("href"));
    switch (href.kind) {
      case "anchor":
        this.scrollToAnchor(href.anchor);
        break;
      case "external":
        await openUrl(href.url);
        break;
      case "local": {
        const currentFile = this.doc.path();
        if (!currentFile) {
          this.notify.emit("No file is open.");
          return;
        }
        const resolved = await resolveLocalLink(href.path, {
          currentFile,
          wikiRoot: this.doc.wikiRoot() ?? currentFile,
          exists: backend.isFile,
        });
        if (!resolved) {
          this.notify.emit(`File not found: ${href.path}`);
        } else if (isMarkdownPath(resolved)) {
          await this.doc.open(resolved, { anchor: href.anchor }).catch((err) => this.notify.emit(String(err)));
        } else {
          await openPath(resolved);
        }
        break;
      }
    }
  }

  /** Resolved links open the note (history included); unresolved ones do nothing yet (#69). */
  private async openWikilink(target: string): Promise<void> {
    const { note, heading } = parseWikilinkTarget(target);
    if (!note) {
      if (heading) this.scrollToAnchor(heading);
      return;
    }
    const root = this.workspace.vaultRoot();
    const files = this.workspace.vaultFiles();
    const resolved = root && files ? resolveWikilink(target, files) : null;
    if (!resolved || !root) return;
    const path = joinPath(root, resolved);
    if (!isMarkdownPath(path)) {
      await openPath(path);
      return;
    }
    await this.doc.open(path, { anchor: heading }).catch((err) => this.notify.emit(String(err)));
  }

  /** `done`: the layout is final (diagrams rendered), so the anchor is consumed. */
  private applyPendingAnchor(done: boolean): void {
    const anchor = this.doc.pendingAnchor();
    if (anchor === null) return;
    if (this.scrollToAnchor(anchor) && done) this.doc.pendingAnchor.set(null);
  }

  /** `done`: the layout is final, so the line is consumed. */
  private applyPendingLine(done: boolean): void {
    const line = this.doc.pendingLine();
    if (line === null) return;
    if (this.scrollToLine(line) && done) this.doc.pendingLine.set(null);
  }

  /** Scrolls to the last top-level block that starts at or before the 1-based source `line`. */
  private scrollToLine(line: number): boolean {
    const blocks = this.content().nativeElement.querySelectorAll<HTMLElement>(":scope > [data-line]");
    let best: HTMLElement | null = null;
    for (const block of Array.from(blocks)) {
      if (Number(block.dataset["line"]) <= line - 1) best = block;
      else break;
    }
    best ??= blocks[0] ?? null;
    if (!best) return false;
    best.scrollIntoView({ block: "start" });
    return true;
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
