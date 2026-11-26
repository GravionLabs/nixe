import { Injector, createComponent, signal } from "@angular/core";
import type {
  ApplicationRef,
  ComponentRef,
  EnvironmentInjector,
  WritableSignal,
} from "@angular/core";

import { BASE_BLOCK_CLASS } from "../../core/markdown/plugins/base-fence.plugin";
import type { BaseChoice } from "../../core/tabs/tabs.service";
import { BASE_BLOCK, BaseComponent } from "./base.component";

/**
 * The bases shown in a rendered note: one `BaseComponent` per base block. `clear` destroys them
 * before the note is rendered again; the chosen views survive that while the note stays.
 */
export class BaseBlocks {
  private readonly shown = new Map<HTMLElement, ComponentRef<BaseComponent>>();
  /** By note, source and how many equal blocks come before. */
  private readonly choices = new Map<string, WritableSignal<BaseChoice>>();
  private note: string | null = null;
  private disposed = false;

  constructor(
    private readonly app: ApplicationRef,
    private readonly environment: EnvironmentInjector,
    private readonly injector: Injector,
  ) {}

  /**
   * Shows the base of every block below `root` that has none yet. `note` is the shown note; a
   * block of an embedded note belongs to that one.
   */
  mount(root: HTMLElement, note: string | null): void {
    // Embedded notes may arrive after the view is gone.
    if (this.disposed) return;
    if (note !== this.note) {
      this.note = note;
      this.choices.clear();
    }
    const seen = new Map<string, number>();
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>(`.${BASE_BLOCK_CLASS}[data-base]`),
    )) {
      const source = decode(el.dataset["base"] ?? "");
      if (source === null) continue;
      const embedding = el.closest<HTMLElement>("[data-source-path]");
      const owner = embedding?.dataset["sourcePath"] ?? note;
      const id = `${owner}\n${source}`;
      const count = seen.get(id) ?? 0;
      seen.set(id, count + 1);
      if (this.shown.has(el)) continue;

      const key = `${count}\n${id}`;
      let choice = this.choices.get(key);
      if (!choice) {
        choice = signal<BaseChoice>({ view: null, sort: null });
        this.choices.set(key, choice);
      }
      const ref = createComponent(BaseComponent, {
        environmentInjector: this.environment,
        elementInjector: Injector.create({
          parent: this.injector,
          providers: [{ provide: BASE_BLOCK, useValue: { source, note: owner, choice } }],
        }),
        hostElement: el,
      });
      this.app.attachView(ref.hostView);
      ref.changeDetectorRef.detectChanges();
      this.shown.set(el, ref);
    }
  }

  /** Destroys the bases and mounts no further ones: the view of the note is gone. */
  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  clear(): void {
    for (const ref of this.shown.values()) {
      this.app.detachView(ref.hostView);
      ref.destroy();
    }
    this.shown.clear();
  }
}

/** The source of a block; null for an attribute written by hand that is no encoded text. */
function decode(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
