import type { OnDestroy } from "@angular/core";
import {
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import type { FoliateBook, FoliateRelocate, FoliateView } from "foliate-js/view.js";

import type { EpubFlow } from "../../core/epub/epub";
import { bookCss, flattenToc } from "../../core/epub/epub";
import { EpubService } from "../../core/epub/epub.service";
import { SettingsService } from "../../core/settings/settings.service";
import { CURRENT_TAB } from "../../core/tabs/tabs.service";
import { EmptyStateComponent } from "../../shared/panel/empty-state.component";

/** The keys that turn the page forward and back; Shift+Space goes back. */
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " "]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp"]);

/**
 * One book in the main area (ADR 0009): the table of contents at the side and the book, laid out
 * by foliate-js in sandboxed frames (no scripts of the book run), paged or scrolled.
 */
@Component({
  selector: "app-epub",
  imports: [EmptyStateComponent],
  templateUrl: "./epub.component.html",
  styleUrl: "./epub.component.css",
})
export class EpubComponent implements OnDestroy {
  private readonly tab = inject(CURRENT_TAB);
  protected readonly epub = inject(EpubService);
  private readonly settings = inject(SettingsService);

  protected readonly book = this.tab.epub;
  protected readonly toc = computed(() => flattenToc(this.book()?.book.toc));
  /** The href of the table of contents entry that holds the reading position. */
  protected readonly current = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private view: FoliateView | null = null;
  private path: string | null = null;
  private generation = 0;
  /** The position of the visible text, to stay on it when the styles change. */
  private cfi: string | null = null;
  private css = "";

  constructor() {
    // After the render: the stage is part of the template.
    afterRenderEffect(() => {
      const book = this.book();
      const stage = this.host.nativeElement.querySelector<HTMLElement>(".stage");
      untracked(() => {
        if (book && stage) void this.mount(book.book, book.path, stage);
        else {
          this.generation++;
          this.unmount();
        }
      });
    });
    effect(() => {
      const flow = this.epub.flow();
      this.view?.renderer?.setAttribute("flow", flow);
    });
    // The theme and the zoom of the app restyle the open book; the position stays.
    effect(() => {
      this.css = bookCss(this.settings.dark(), this.settings.zoom());
      untracked(() => void this.restyle());
    });
  }

  ngOnDestroy(): void {
    this.generation++;
    this.unmount();
  }

  private async restyle(): Promise<void> {
    const view = this.view;
    if (!view?.renderer?.setStyles) return;
    view.renderer.setStyles(this.css);
    // The text reflows with the size: go back to the text that was in view.
    const cfi = this.cfi;
    if (cfi === null) return;
    try {
      await view.goTo(cfi);
    } catch {
      // The position stays where foliate-js left it.
    }
  }

  protected setFlow(flow: EpubFlow): void {
    this.epub.setFlow(flow);
  }

  protected go(href: string): void {
    this.view?.goTo(href).catch(() => undefined);
  }

  protected next(): void {
    this.view?.next().catch(() => undefined);
  }

  protected prev(): void {
    this.view?.prev().catch(() => undefined);
  }

  /** Space, Page up/down and the arrow keys turn the page; keys typed into a control are left alone. */
  protected onKey(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    // Space on a button or a link activates it.
    const target = event.target;
    if (event.key === " " && target instanceof HTMLElement && target.closest("button, a")) return;
    const forward = NEXT_KEYS.has(event.key) && !(event.key === " " && event.shiftKey);
    const back = PREV_KEYS.has(event.key) || (event.key === " " && event.shiftKey);
    if (!forward && !back) return;
    event.preventDefault();
    if (forward) this.next();
    else this.prev();
  }

  private async mount(book: FoliateBook, path: string, stage: HTMLElement): Promise<void> {
    const run = ++this.generation;
    this.unmount();
    this.error.set(null);
    try {
      await import("foliate-js/view.js");
      if (run !== this.generation) return;
      let saved: string | null = null;
      const view = document.createElement("foliate-view") as FoliateView;
      view.className = "book";
      view.addEventListener("relocate", (event) => {
        const detail = (event as CustomEvent<FoliateRelocate>).detail;
        this.current.set(detail.tocItem?.href ?? null);
        if (detail.cfi) this.cfi = detail.cfi;
        // The relocation that restores the saved position writes nothing.
        if (!detail.cfi) return;
        const restored = detail.cfi === saved;
        saved = null;
        if (!restored) this.epub.savePosition(path, detail.cfi);
      });
      // The keys of a focused book frame do not reach the page: the frame's document tells them.
      view.addEventListener("load", (event) => {
        const doc = (event as CustomEvent<{ doc: Document }>).detail.doc;
        doc.addEventListener("keydown", (key) => this.onKey(key));
      });
      stage.append(view);
      this.view = view;
      this.path = path;
      await view.open(book);
      if (run !== this.generation) return;
      view.renderer.setAttribute("flow", this.epub.flow());
      view.renderer.setStyles?.(this.css);
      const last = await this.epub.position(path);
      if (run !== this.generation) return;
      saved = last;
      await view.init({ lastLocation: last, showTextStart: last === null });
    } catch (err) {
      if (run === this.generation) this.error.set(String(err instanceof Error ? err.message : err));
    }
  }

  private unmount(): void {
    const view = this.view;
    this.view = null;
    if (this.path !== null) this.epub.flushPosition(this.path);
    this.path = null;
    this.cfi = null;
    if (!view) return;
    try {
      view.close();
    } catch {
      // A view that never opened has nothing to close.
    }
    view.remove();
    this.current.set(null);
  }
}
