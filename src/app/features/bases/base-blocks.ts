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
import type { BaseBlock, KeptAnswer } from "./base.component";
import type { BaseOrigin } from "../../core/editor/live-preview-core";

/** What a base of a note keeps while the note stays, also while it is not drawn. */
interface Kept {
  choice: WritableSignal<BaseChoice>;
  answer: { current: KeptAnswer | null };
}

/**
 * The bases shown in a note: one `BaseComponent` per base block or `.base` embed. The reading view
 * mounts them into its rendered HTML and `clear`s them before the note is rendered again, the live
 * preview `show`s one per widget. The chosen views survive that while the note stays.
 */
export class BaseBlocks {
  private readonly shown = new Map<HTMLElement, ComponentRef<BaseComponent>>();
  /** By note, source or embed target, and how many equal blocks come before. */
  private readonly kept = new Map<string, Kept>();
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
    this.enter(note);
    const seen = new Map<string, number>();
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>(
        `.${BASE_BLOCK_CLASS}[data-base], .${BASE_BLOCK_CLASS}[data-base-embed]`,
      ),
    )) {
      const from = originOf(el);
      if (!from) continue;
      const embedding = el.closest<HTMLElement>("[data-source-path]");
      const owner = embedding?.dataset["sourcePath"] ?? note;
      const id = `${owner}\n${JSON.stringify(from)}`;
      const count = seen.get(id) ?? 0;
      seen.set(id, count + 1);
      if (this.shown.has(el)) continue;

      const { choice } = this.keptFor(`${count}\n${id}`);
      this.create(el, { ...from, note: owner, choice });
    }
  }

  /**
   * Shows one base in `el`, with editable cells, for a block of the live preview of `note`.
   * The answer to its query is kept, so showing it again does not ask the vault anew while nothing
   * changed. Returns what removes the base.
   */
  show(el: HTMLElement, from: BaseOrigin, occurrence: number, note: string | null): () => void {
    if (this.disposed) return () => undefined;
    this.enter(note);
    const { choice, answer } = this.keptFor(`${occurrence}\n${note}\n${JSON.stringify(from)}`);
    this.create(el, { ...from, note, choice, answer, editable: true });
    return () => this.remove(el);
  }

  /** `note` is shown now: another note than before starts with the first views again. */
  enter(note: string | null): void {
    if (note === this.note) return;
    this.note = note;
    this.kept.clear();
  }

  private keptFor(key: string): Kept {
    let kept = this.kept.get(key);
    if (!kept) {
      kept = {
        choice: signal<BaseChoice>({ view: null, sort: null }),
        answer: { current: null },
      };
      this.kept.set(key, kept);
    }
    return kept;
  }

  private create(el: HTMLElement, block: BaseBlock): void {
    const ref = createComponent(BaseComponent, {
      environmentInjector: this.environment,
      elementInjector: Injector.create({
        parent: this.injector,
        providers: [{ provide: BASE_BLOCK, useValue: block }],
      }),
      hostElement: el,
    });
    this.app.attachView(ref.hostView);
    ref.changeDetectorRef.detectChanges();
    this.shown.set(el, ref);
  }

  private remove(el: HTMLElement): void {
    const ref = this.shown.get(el);
    if (!ref) return;
    this.shown.delete(el);
    this.app.detachView(ref.hostView);
    ref.destroy();
  }

  /** Whether `node` is part of a shown base. */
  holds(node: Node): boolean {
    return [...this.shown.keys()].some((el) => el.contains(node));
  }

  /** Destroys the bases and mounts no further ones: the view of the note is gone. */
  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  clear(): void {
    for (const el of this.shown.keys()) this.remove(el);
  }
}

/** Where the base of a block comes from: the target of an embed, else the source of a fence. */
function originOf(el: HTMLElement): { source: string } | { embed: string } | null {
  const embed = el.dataset["baseEmbed"];
  if (embed !== undefined) {
    const target = decode(embed);
    return target === null ? null : { embed: target };
  }
  const source = decode(el.dataset["base"] ?? "");
  return source === null ? null : { source };
}

/** The source or embed target of a block; null for an attribute written by hand that is no encoded text. */
function decode(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}
