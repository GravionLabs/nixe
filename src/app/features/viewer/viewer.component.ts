import {
  ApplicationRef,
  Component,
  DestroyRef,
  ElementRef,
  EnvironmentInjector,
  Injector,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { HxMenuItem } from "@gravionlabs/helix-ui";
import { HxMenu } from "@gravionlabs/helix-ui";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import { viewerTopLine } from "../../core/editor/editor-core";
import { FoldStateService } from "../../core/fold/fold-state.service";
import type { HeadingFold } from "../../core/fold/viewer-folds";
import { applyHeadingFolds, commandTarget } from "../../core/fold/viewer-folds";
import type { TextPart } from "../../core/find/find-core";
import { findInParts, stepIndex } from "../../core/find/find-core";
import { STDIN_FILE_SUFFIX, backend } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { classifyHref, resolveLocalLink } from "../../core/markdown/link-resolver";
import { slugify } from "../../core/markdown/markdown-renderer";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { decorateCodeBlocks, handleCopyClick } from "../../core/markdown/code-blocks";
import { MermaidRenderer } from "../../core/markdown/mermaid-renderer";
import {
  assetFilePath,
  decorateImages,
  imageNaturalSize,
  revealLabel,
} from "../../core/markdown/image-zoom";
import { isEpubPath, isMarkdownPath, isRemoteEpubUrl, joinPath } from "../../core/markdown/paths";
import { parseWikilinkTarget, resolveWikilink } from "../../core/markdown/wikilink-resolver";
import { setTaskState, taskShape } from "../../core/markdown/task-toggle";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { OutlineService } from "../../core/outline/outline.service";
import { ShellService } from "../../core/shell/shell.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { BaseBlocks } from "../bases/base-blocks";
import { PropertiesComponent } from "../properties/properties.component";
import { SearchService } from "../../core/index/search.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { WorkspacesService } from "../../core/workspace/workspaces.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { SettingsService } from "../../core/settings/settings.service";

const DIALOG_ZOOM_MIN = 0.25;
const DIALOG_ZOOM_MAX = 6;
const DIALOG_ZOOM_STEP = 1.1;

@Component({
  selector: "app-viewer",
  templateUrl: "./viewer.component.html",
  styleUrl: "./viewer.component.css",
  imports: [HxMenu, PropertiesComponent],
  host: { "(scroll)": "trackScroll()" },
})
export class ViewerComponent {
  /** Sanitized HTML (see MarkdownService). */
  readonly html = input.required<string>();
  readonly dark = input(false);
  readonly notify = output<string>();

  private readonly doc = inject(DocumentService);
  private readonly outline = inject(OutlineService);
  protected readonly preview = inject(LinkPreviewService);
  private readonly tabs = inject(TabsService);
  private readonly shell = inject(ShellService);
  private readonly workspace = inject(WorkspaceService);
  private readonly workspaces = inject(WorkspacesService);
  private readonly ops = inject(VaultOpsService);
  private readonly search = inject(SearchService);
  protected readonly settings = inject(SettingsService);
  private readonly markdown = inject(MarkdownService);
  private readonly folds = inject(FoldStateService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly content = viewChild.required<ElementRef<HTMLElement>>("content");
  /** Always mounted (visibility toggled via CSS), so it's available as soon as a diagram is clicked. */
  private readonly dialogContent = viewChild<ElementRef<HTMLElement>>("dialogContent");
  private readonly findInput = viewChild<ElementRef<HTMLInputElement>>("findInput");
  private readonly mermaid = new MermaidRenderer();
  private readonly bases = new BaseBlocks(
    inject(ApplicationRef),
    inject(EnvironmentInjector),
    inject(Injector),
  );
  private renderedPath: string | null = null;
  /** Text this viewer just saved from a checkbox: its DOM is already right, so that render is skipped. */
  private toggledText: string | null = null;
  /** Toggles run one after the other, so a quick second click builds on the saved first one. */
  private toggleQueue: Promise<void> = Promise.resolve();

  protected readonly dialogOpen = signal(false);
  /** File of the image in the dialog (offers "Open with default app" and reveal); null for diagrams and remote images. */
  protected readonly dialogFile = signal<string | null>(null);
  /** The "Open image" menu of an image that sits inside a link. */
  private readonly imageMenu = viewChild<HxMenu>("imageMenu");
  /** The image the context menu was opened on. */
  private menuImage: HTMLImageElement | null = null;
  protected readonly imageMenuItems: HxMenuItem[] = [
    { label: "Open image", command: () => this.openMenuImage() },
  ];
  protected readonly revealText = revealLabel(navigator.userAgent);
  protected readonly panning = signal(false);
  private pan: { x: number; y: number; left: number; top: number } | null = null;
  /** Element that opened the dialog; gets the focus back on close. */
  private dialogOpener: HTMLElement | null = null;
  protected readonly dialogZoom = signal(1);
  protected readonly dialogZoomPercent = computed(() => Math.round(this.dialogZoom() * 100));
  protected readonly findOpen = signal(false);
  protected readonly findQuery = signal("");
  protected readonly findCase = signal(false);
  protected readonly findRegex = signal(false);
  private readonly findError = signal<string | null>(null);
  private readonly findCount = signal(0);
  private readonly findCurrent = signal(-1);
  protected readonly findStatus = computed(() => {
    if (this.findError()) return "Invalid";
    if (!this.findQuery()) return "";
    return this.findCount() === 0
      ? "No matches"
      : `${this.findCurrent() + 1} / ${this.findCount()}`;
  });
  private findMarks: HTMLElement[][] = [];

  /** The dialog's diagram, in its own SVG user units (from its viewBox) at zoom 1. */
  private dialogNaturalSize: { width: number; height: number } | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.bases.dispose());
    effect(() => {
      const el = this.content().nativeElement;
      const html = this.html();
      const dark = this.dark();
      // Another note renders anew, also with the same HTML: its bases have another `this`.
      const path = this.doc.path();
      untracked(() => {
        const skip = this.toggledText !== null && this.toggledText === this.doc.content();
        this.toggledText = null;
        if (skip) return;
        this.bases.clear();
        el.innerHTML = html; // already sanitized with DOMPurify
        // A newly opened document starts at the top (external reloads keep the position).
        if (path !== this.renderedPath) {
          this.renderedPath = path;
          this.host.nativeElement.scrollTop = 0;
        }
        this.findMarks = [];
        decorateCodeBlocks(el);
        decorateImages(el);
        // After the images: those of a base are its own.
        this.bases.mount(el, path);
        this.enableTasks();
        void this.syncFolds();
        this.applyPendingAnchor(false);
        this.applyPendingLine(false);
        this.trackScroll();
        this.refreshFind(false);
        // Diagrams change the layout, so the anchor is applied again afterwards.
        // Embedded notes are loaded first so diagrams inside them render too.
        void this.markdown
          .expandEmbeds(el, {
            filePath: path,
            wikiRoot: this.doc.wikiRoot(),
            math: this.settings.math(),
            vaultFiles: this.workspace.vaultFiles(),
            vaultRoot: this.workspace.vaultRoot(),
            bases: true,
          })
          .catch(() => undefined)
          .then(() => this.mermaid.render(el, dark))
          .then(() => {
            decorateCodeBlocks(el);
            decorateImages(el);
            // The blocks of embedded notes; a render that came meanwhile shows another note.
            this.bases.mount(el, this.renderedPath);
          })
          .then(() => this.syncFolds())
          .then(() => {
            this.enableTasks();
            this.applyPendingAnchor(true);
            this.applyPendingLine(true);
            this.trackScroll();
            this.refreshFind(false);
          });
      });
    });

    // Back to a heading of the note that is already shown renders nothing new, so scroll here.
    effect(() => {
      const anchor = this.doc.pendingAnchor();
      if (anchor === null) return;
      untracked(() => {
        if (this.renderedPath === this.doc.path() && this.scrollToAnchor(anchor))
          this.doc.pendingAnchor.set(null);
      });
    });

    // Opening a line of the note that is already shown renders nothing new, so scroll here.
    effect(() => {
      const line = this.doc.pendingLine();
      if (line === null) return;
      untracked(() => {
        if (this.renderedPath === this.doc.path() && this.scrollToLine(line))
          this.doc.pendingLine.set(null);
      });
    });
  }

  /** Headings of the shown note that can fold, after the last `syncFolds`. */
  private headings: HeadingFold[] = [];
  /** Folded source lines of the shown note (all kinds; the editor also folds lists and the frontmatter). */
  private foldedLines = new Set<number>();

  /** Applies the remembered folds of the note to the rendered headings. */
  private async syncFolds(): Promise<void> {
    const path = this.doc.path();
    if (path) {
      // The editor may have changed the folds since the last render, so they are read again.
      const stored = this.folds.peek(path) ?? (await this.folds.linesOf(path));
      if (this.doc.path() !== path) return;
      this.foldedLines = new Set(stored);
    } else {
      this.foldedLines = new Set();
    }
    this.headings = applyHeadingFolds(this.content().nativeElement, this.foldedLines);
  }

  private setFolded(change: (lines: Set<number>) => void): void {
    const path = this.doc.path();
    if (!path) return;
    change(this.foldedLines);
    this.headings = applyHeadingFolds(this.content().nativeElement, this.foldedLines);
    this.folds.set(path, [...this.foldedLines]);
    this.trackScroll();
  }

  /** Folds or unfolds the heading at the top of the view, or every heading of the note. */
  fold(action: "fold" | "unfold" | "fold-all" | "unfold-all"): void {
    if (action === "fold-all") {
      this.setFolded((lines) =>
        this.headings.filter((h) => h.foldable).forEach((h) => lines.add(h.line)),
      );
    } else if (action === "unfold-all") {
      this.setFolded((lines) => this.headings.forEach((h) => lines.delete(h.line)));
    } else {
      const target = commandTarget(this.headings, this.topLine(), action);
      if (target)
        this.setFolded((lines) =>
          action === "fold" ? lines.add(target.line) : lines.delete(target.line),
        );
    }
  }

  /** Opens the find bar (⌘/Ctrl+F), or focuses it when it is open. */
  openFind(): void {
    this.findOpen.set(true);
    setTimeout(() => {
      const input = this.findInput()?.nativeElement;
      input?.focus();
      input?.select();
    });
    this.refreshFind(true);
  }

  protected closeFind(): void {
    this.findOpen.set(false);
    this.clearFind();
    this.content().nativeElement.focus({ preventScroll: true });
  }

  protected onFindKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeFind();
    } else if (event.key === "Enter") {
      event.preventDefault();
      this.findStep(event.shiftKey ? -1 : 1);
    }
  }

  protected setFindQuery(query: string): void {
    this.findQuery.set(query);
    this.refreshFind(true);
  }

  protected toggleFindOption(option: "case" | "regex"): void {
    (option === "case" ? this.findCase : this.findRegex).update((v) => !v);
    this.refreshFind(true);
  }

  protected findStep(step: 1 | -1): void {
    const next = stepIndex(this.findCurrent(), step, this.findMarks.length);
    this.activateMatch(next);
  }

  /** Removes the highlights and puts the text back together. */
  private clearFind(): void {
    const el = this.content().nativeElement;
    for (const mark of Array.from(el.querySelectorAll("mark.find-hit"))) {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
      parent?.normalize();
    }
    this.findMarks = [];
    this.findCount.set(0);
    this.findCurrent.set(-1);
    this.findError.set(null);
  }

  /** Highlights the matches of the query in the rendered note; `jump` selects and scrolls to the first. */
  private refreshFind(jump: boolean): void {
    if (!this.findOpen()) return;
    const previous = this.findCurrent();
    this.clearFind();
    const query = this.findQuery();
    if (!query) return;
    const nodes = this.textNodes();
    const parts: TextPart[] = nodes.map((n) => ({
      text: n.data,
      group: blockId(n, this.content().nativeElement),
    }));
    const result = findInParts(parts, query, {
      caseSensitive: this.findCase(),
      regex: this.findRegex(),
    });
    if (typeof result === "string") {
      this.findError.set(result);
      return;
    }
    // Wrap from the end of each node so earlier offsets stay valid.
    const marks: HTMLElement[][] = result.matches.map(() => []);
    const byNode = new Map<number, typeof result.segments>();
    for (const seg of result.segments) byNode.set(seg.part, [...(byNode.get(seg.part) ?? []), seg]);
    for (const [index, segs] of byNode) {
      const node = nodes[index]!;
      for (const seg of [...segs].sort((a, b) => b.from - a.from)) {
        const range = document.createRange();
        range.setStart(node, seg.from);
        range.setEnd(node, seg.to);
        const mark = document.createElement("mark");
        mark.className = "find-hit";
        range.surroundContents(mark);
        marks[seg.match]!.unshift(mark);
      }
    }
    for (const group of marks) {
      group.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
    }
    this.findMarks = marks;
    this.findCount.set(marks.length);
    if (marks.length)
      this.activateMatch(jump ? 0 : Math.min(Math.max(previous, 0), marks.length - 1), jump);
  }

  private activateMatch(index: number, scroll = true): void {
    for (const mark of this.findMarks.flat()) mark.classList.remove("find-active");
    this.findCurrent.set(index);
    const marks = this.findMarks[index];
    if (!marks?.length) return;
    for (const mark of marks) mark.classList.add("find-active");
    if (scroll) marks[0]!.scrollIntoView({ block: "center" });
  }

  /** Text of the note as rendered; diagrams and scripts are skipped. */
  private textNodes(): Text[] {
    const root = this.content().nativeElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest("svg, script, style, .mermaid-diagram, .base-block") ||
        !(node as Text).data
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    return nodes;
  }

  /** 1-based source line at the top of the visible area; null when no block carries one. */
  topLine(): number | null {
    const top = this.host.nativeElement.getBoundingClientRect().top;
    const blocks = Array.from(
      this.content().nativeElement.querySelectorAll<HTMLElement>(":scope > [data-line]"),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return { line: Number(el.dataset["line"]), top: rect.top - top, bottom: rect.bottom - top };
    });
    return viewerTopLine(blocks, 0);
  }

  /** Tells the outline which line is at the top. */
  protected trackScroll(): void {
    this.outline.topLine.set(this.topLine());
  }

  /** A resolved wikilink under the pointer gets a preview (see LinkPreviewService). */
  protected onHover(event: MouseEvent): void {
    const link = (event.target as Element).closest?.("a.wikilink:not(.unresolved)");
    const target = link?.getAttribute("data-target");
    if (!link || !target) {
      this.preview.leave();
      return;
    }
    this.preview.hover(target, link.getBoundingClientRect(), event.metaKey || event.ctrlKey);
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
    const svg = this.dialogContent()?.nativeElement.querySelector<SVGSVGElement | HTMLImageElement>(
      "svg, img",
    );
    const size = this.dialogNaturalSize;
    if (!svg || !size) return;
    const zoom = this.dialogZoom();
    svg.style.maxWidth = "none";
    svg.style.width = `${size.width * zoom}px`;
    svg.style.height = `${size.height * zoom}px`;
  }

  closeDiagram(): void {
    this.dialogOpen.set(false);
    this.pan = null;
    this.panning.set(false);
    document.removeEventListener("keydown", this.onDialogKeydown);
    const opener = this.dialogOpener;
    this.dialogOpener = null;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  /** Drag to pan the zoomed content. */
  protected onPanStart(event: PointerEvent): void {
    if (event.button !== 0) return;
    const viewport = event.currentTarget as HTMLElement;
    this.pan = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    this.panning.set(true);
    viewport.setPointerCapture?.(event.pointerId);
  }

  protected onPanMove(event: PointerEvent): void {
    if (!this.pan) return;
    const viewport = event.currentTarget as HTMLElement;
    viewport.scrollLeft = this.pan.left - (event.clientX - this.pan.x);
    viewport.scrollTop = this.pan.top - (event.clientY - this.pan.y);
  }

  protected onPanEnd(event: PointerEvent): void {
    if (!this.pan) return;
    this.pan = null;
    this.panning.set(false);
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  /** Shows `img` in the zoom dialog; `size` is its size at zoom 1. */
  private openImage(img: HTMLImageElement): void {
    const container = this.dialogContent()?.nativeElement;
    if (!container) return;
    const copy = document.createElement("img");
    copy.src = img.currentSrc || img.src;
    copy.alt = img.alt;
    copy.draggable = false;
    container.replaceChildren(copy);
    // Sized (not transformed) so an SVG is rendered again at every zoom level and stays sharp.
    this.dialogNaturalSize = imageNaturalSize(img);
    this.dialogFile.set(assetFilePath(copy.src));
    this.dialogZoom.set(1);
    this.applyDialogZoom();
    this.showDialog(img);
  }

  private showDialog(opener: HTMLElement | null): void {
    this.dialogOpener = opener;
    this.dialogOpen.set(true);
    document.addEventListener("keydown", this.onDialogKeydown);
  }

  protected async openDialogFile(path: string): Promise<void> {
    try {
      await openPath(path);
    } catch (err) {
      this.notify.emit(String(err));
    }
  }

  protected async revealDialogFile(path: string): Promise<void> {
    try {
      await revealItemInDir(path);
    } catch (err) {
      this.notify.emit(String(err));
    }
  }

  /** Enter on a focused image opens it. */
  protected onContentKeydown(event: KeyboardEvent): void {
    const target = event.target;
    if (
      event.key !== "Enter" ||
      !(target instanceof HTMLImageElement) ||
      !target.hasAttribute("data-zoomable")
    )
      return;
    event.preventDefault();
    this.openImage(target);
  }

  /** An image inside a link follows the link on click; its dialog is in the context menu. */
  protected onContextMenu(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.closest("a")) return;
    event.preventDefault();
    this.menuImage = target;
    this.imageMenu()?.showAt({ x: event.clientX, y: event.clientY }, this.content().nativeElement);
  }

  private openMenuImage(): void {
    const img = this.menuImage;
    this.menuImage = null;
    if (img) this.openImage(img);
  }

  private readonly onDialogKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") this.closeDiagram();
  };

  async onClick(event: MouseEvent): Promise<void> {
    const target = event.target as Element;
    // A base handles its own clicks.
    if (this.bases.holds(target)) return;
    if (await handleCopyClick(target)) return;

    const marker = target.closest<HTMLElement>(".fold-marker");
    if (marker?.parentElement) {
      const heading = this.headings.find((h) => h.el === marker.parentElement);
      if (heading) {
        this.setFolded((lines) =>
          heading.folded ? lines.delete(heading.line) : lines.add(heading.line),
        );
        return;
      }
    }

    const diagram = target.closest<HTMLElement>(".mermaid-diagram");
    if (diagram && !target.closest("a")) {
      const svg = diagram.querySelector("svg");
      const container = this.dialogContent()?.nativeElement;
      if (svg && container) {
        container.innerHTML = svg.outerHTML;
        this.dialogFile.set(null);
        const clone = container.querySelector<SVGSVGElement>("svg");
        const viewBox = clone?.viewBox.baseVal;
        this.dialogNaturalSize =
          viewBox && viewBox.width && viewBox.height
            ? { width: viewBox.width, height: viewBox.height }
            : { width: clone?.clientWidth || 300, height: clone?.clientHeight || 150 };
        this.dialogZoom.set(1);
        this.applyDialogZoom();
        this.showDialog(null);
      }
      return;
    }

    if (target instanceof HTMLImageElement && target.hasAttribute("data-zoomable")) {
      this.openImage(target);
      return;
    }

    if (
      target instanceof HTMLInputElement &&
      target.classList.contains("task-list-item-checkbox")
    ) {
      const run = this.toggleQueue.then(() => this.toggleTask(event, target));
      this.toggleQueue = run.catch(() => undefined);
      await run;
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
      if (name) {
        this.shell.show("search");
        this.search.openWith(`tag:#${name}`);
      }
      return;
    }

    const wikiTarget = link.classList.contains("wikilink")
      ? link.getAttribute("data-target")
      : null;
    if (wikiTarget !== null) {
      await this.openWikilink(wikiTarget, event.metaKey || event.ctrlKey);
      return;
    }

    const href = classifyHref(link.getAttribute("href"));
    switch (href.kind) {
      case "anchor":
        this.jumpToAnchor(href.anchor);
        break;
      case "external":
        if (isRemoteEpubUrl(href.url)) await this.openBook(href.url);
        else await openUrl(href.url);
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
          await this.openNote(resolved, { anchor: href.anchor }, event.metaKey || event.ctrlKey);
        } else if (isEpubPath(resolved)) {
          await this.openBook(resolved);
        } else {
          await openPath(resolved);
        }
        break;
      }
    }
  }

  /** Checkboxes are rendered disabled; here they are enabled where a source line is known to write to. */
  private enableTasks(): void {
    const piped = this.doc.path()?.endsWith(STDIN_FILE_SUFFIX) ?? false;
    for (const box of Array.from(
      this.content().nativeElement.querySelectorAll<HTMLInputElement>(
        "input.task-list-item-checkbox",
      ),
    )) {
      const embed = box.closest<HTMLElement>(".embed-body");
      const known = embed ? !!embed.dataset["sourcePath"] : !piped && !!this.doc.path();
      box.disabled = !known || !box.closest("[data-line]");
    }
  }

  /** Writes the ticked or unticked task to the file of the item (the open note or an embedded one). */
  private async toggleTask(event: Event, box: HTMLInputElement): Promise<void> {
    const item = box.closest<HTMLElement>("li[data-line]");
    const embed = box.closest<HTMLElement>(".embed-body");
    const path = embed ? embed.dataset["sourcePath"] : this.doc.path();
    if (!item || !path || (!embed && path.endsWith(STDIN_FILE_SUFFIX))) {
      event.preventDefault();
      return;
    }
    const line = Number(item.dataset["line"]) + Number(embed?.dataset["lineOffset"] ?? 0);
    const checked = box.checked; // the browser has already flipped it
    const isOpenNote = path === this.doc.path();
    try {
      const text = isOpenNote ? this.doc.content() : await backend.readTextFile(path);
      const next = setTaskState(text, line, checked);
      const rendered = item.dataset["srcLine"];
      const stale =
        embed && rendered !== undefined && taskShape(text.split("\n")[line] ?? "") !== rendered;
      if (next === null || stale) {
        // Not a `[ ]`/`[x]` line any more (the file changed): leave the file alone.
        box.checked = !checked;
        return;
      }
      if (isOpenNote) this.toggledText = next;
      await this.doc.write(path, next);
    } catch (err) {
      this.toggledText = null;
      box.checked = !checked;
      this.notify.emit(String(err));
    }
  }

  /** Resolved links open the note (history included); unresolved ones create the note. */
  /** Opens a note in this tab, or in a new one (⌘/Ctrl+click). */
  private async openNote(
    path: string,
    options: { anchor?: string | null },
    newTab: boolean,
  ): Promise<void> {
    try {
      if (newTab) await this.tabs.openInNewTab(path, options);
      else await this.tabs.openPreview(path, options);
    } catch (err) {
      this.notify.emit(String(err));
    }
  }

  /** Opens an EPUB book in the reader tab; a book that cannot be read shows its error. */
  private async openBook(path: string): Promise<void> {
    try {
      await this.tabs.openEpub(path);
    } catch (err) {
      this.notify.emit(String(err));
    }
  }

  private async openWikilink(target: string, newTab = false): Promise<void> {
    const { note, heading } = parseWikilinkTarget(target);
    if (!note) {
      if (heading) this.jumpToAnchor(heading);
      return;
    }
    const other = await this.workspaces.resolveLink(target, this.doc.path());
    if (other) {
      if (isEpubPath(other)) await this.openBook(other);
      else await this.openNote(other, { anchor: heading }, newTab);
      return;
    }
    // A book that is not there is no note to create.
    if (isEpubPath(note) && other === null) {
      this.notify.emit(`File not found: ${note}`);
      return;
    }
    const root = this.workspace.vaultRoot();
    const files = this.workspace.vaultFiles();
    const resolved = root && files && other === undefined ? resolveWikilink(target, files) : null;
    if (!root || !files) return;
    if (!resolved) {
      if (isEpubPath(note)) this.notify.emit(`File not found: ${note}`);
      else await this.ops.createNoteForLink(target).catch((err) => this.notify.emit(String(err)));
      return;
    }
    const path = joinPath(root, resolved);
    if (isEpubPath(path)) {
      await this.openBook(path);
      return;
    }
    if (!isMarkdownPath(path)) {
      await openPath(path);
      return;
    }
    await this.openNote(path, { anchor: heading }, newTab);
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
    const blocks =
      this.content().nativeElement.querySelectorAll<HTMLElement>(":scope > [data-line]");
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

  /** A link to a heading of this note: the jump becomes a history entry. */
  private jumpToAnchor(anchor: string): void {
    this.doc.jump({ anchor }, () => this.scrollToAnchor(anchor));
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

const BLOCKS = "p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote, div, dt, dd, summary";
const blockIds = new WeakMap<Element, number>();
let nextBlockId = 0;

/** A number that is the same for all text nodes of the nearest block element. */
function blockId(node: Node, root: HTMLElement): number {
  const block = node.parentElement?.closest(BLOCKS) ?? root;
  let id = blockIds.get(block);
  if (id === undefined) blockIds.set(block, (id = nextBlockId++));
  return id;
}
