import {
  Component,
  ElementRef,
  OnDestroy,
  signal,
  ViewChild,
} from "@angular/core";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";

import { CHECKLIST_ITEMS, Rating, checklistMarkdown } from "./decoration-logic";
import { livePreviewSpike } from "./decorations";

/** Temporary prototype for #59 (CodeMirror 6 on iOS). Dev builds only; remove after the spike. */
@Component({
  selector: "app-editor-spike",
  template: `
    <details class="spike">
      <summary>Editor spike (#59)</summary>
      <div class="row">
        <select #pick (change)="open(pick.value)">
          <option value="">choose a note</option>
          @for (n of names(); track n) {
            <option [value]="n">{{ n }}</option>
          }
        </select>
        <button type="button" (click)="refresh()">Reload list</button>
        <button type="button" (click)="save()" [disabled]="!current()">
          Save
        </button>
      </div>
      <p>{{ status() }}</p>
      <div #host class="host"></div>
      <h4>Checklist</h4>
      @for (item of items; track item) {
        <div class="item">
          <span>{{ item }}</span>
          @for (r of ratingsList; track r) {
            <button
              type="button"
              [class.on]="ratings()[item] === r"
              (click)="rate(item, r)"
            >
              {{ r }}
            </button>
          }
          <input
            placeholder="note"
            (input)="note(item, $any($event.target).value)"
          />
        </div>
      }
      <button type="button" (click)="copy()">Copy result as markdown</button>
    </details>
  `,
  styles: `
    .spike {
      padding: 0.5rem 1rem;
      font-size: 0.85rem;
    }
    .row,
    .item {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
      align-items: center;
      margin: 0.25rem 0;
    }
    .item span {
      min-width: 12rem;
    }
    .on {
      font-weight: bold;
      text-decoration: underline;
    }
    .host {
      height: 50vh;
      border: 1px solid gray;
      overflow: hidden;
    }
    .host ::ng-deep .cm-editor {
      height: 100%;
    }
    .host ::ng-deep .cm-scroller {
      overflow: auto;
    }
  `,
})
export class EditorSpikeComponent implements OnDestroy {
  protected readonly items = CHECKLIST_ITEMS;
  protected readonly ratingsList: Rating[] = ["ok", "annoying", "blocker"];
  protected readonly names = signal<string[]>([]);
  protected readonly current = signal("");
  protected readonly status = signal("");
  protected readonly ratings = signal<Record<string, Rating | undefined>>({});
  private notes: Record<string, string> = {};
  private view: EditorView | undefined;
  @ViewChild("host", { static: true }) private host!: ElementRef<HTMLElement>;

  constructor() {
    void this.refresh();
  }

  ngOnDestroy(): void {
    this.view?.destroy();
  }

  protected async refresh(): Promise<void> {
    try {
      this.names.set(await invoke<string[]>("notes_list"));
    } catch (error) {
      this.status.set(`list FAILED ${String(error)}`);
    }
  }

  protected async open(name: string): Promise<void> {
    if (!name) return;
    try {
      const start = performance.now();
      const text = await invoke<string>("notes_read", { name });
      this.view?.destroy();
      this.view = new EditorView({
        parent: this.host.nativeElement,
        state: EditorState.create({
          doc: text,
          extensions: [
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            markdown(),
            EditorView.lineWrapping,
            livePreviewSpike,
          ],
        }),
      });
      this.current.set(name);
      this.status.set(
        `opened ${name} (${text.split("\n").length} lines) in ${Math.round(performance.now() - start)} ms`,
      );
    } catch (error) {
      this.status.set(`open FAILED ${String(error)}`);
    }
  }

  protected async save(): Promise<void> {
    if (!this.view) return;
    try {
      await invoke("notes_write", {
        name: this.current(),
        content: this.view.state.doc.toString(),
      });
      this.status.set(`saved ${this.current()}`);
    } catch (error) {
      this.status.set(`save FAILED ${String(error)}`);
    }
  }

  protected rate(item: string, rating: Rating): void {
    this.ratings.update((r) => ({ ...r, [item]: rating }));
  }

  protected note(item: string, text: string): void {
    this.notes[item] = text;
  }

  protected async copy(): Promise<void> {
    const md = checklistMarkdown(this.ratings(), this.notes);
    try {
      await navigator.clipboard.writeText(md);
      this.status.set("checklist copied");
    } catch (error) {
      this.status.set(`copy FAILED ${String(error)}\n${md}`);
    }
  }
}
