import { Component, ElementRef, effect, inject, output, viewChild } from "@angular/core";

import { KeyHintsComponent, KeyHint, isMac, modKey } from "./key-hints.component";
import { DocumentService } from "../../core/file/document.service";
import { joinPath } from "../../core/markdown/paths";
import { SwitcherMatch, highlightParts } from "../../core/switcher/fuzzy";
import { SwitcherService } from "../../core/switcher/switcher.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** Quick switcher overlay: type a few letters, arrow keys to choose, Enter to open. */
@Component({
  selector: "app-switcher",
  templateUrl: "./switcher.component.html",
  styleUrl: "./switcher.component.css",
  imports: [KeyHintsComponent],
})
export class SwitcherComponent {
  protected readonly switcher = inject(SwitcherService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly ops = inject(VaultOpsService);
  private readonly tabs = inject(TabsService);

  readonly error = output<string>();
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("input");

  protected readonly parts = highlightParts;

  /** The keys of the dialog; "Enter to create" replaces "open" when nothing matches. */
  protected hints(): KeyHint[] {
    const none = this.switcher.matches().length === 0;
    return [
      none ? { keys: "Enter", label: "to create" } : { keys: "Enter", label: "open" },
      { keys: `${modKey()}+Enter`, label: "new tab" },
      { keys: "↑↓", label: "move" },
      { keys: "Esc", label: "close" },
    ];
  }

  /** Text for the live region: the number of results, or that nothing matches. */
  protected announcement(): string {
    const n = this.switcher.matches().length;
    if (!n) return this.switcher.query().trim() ? "No notes match" : "No notes";
    return n === 1 ? "1 result" : `${n} results`;
  }

  constructor() {
    effect(() => this.input()?.nativeElement.focus());
  }

  protected onInput(event: Event): void {
    this.switcher.setQuery((event.target as HTMLInputElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        this.switcher.move(1);
        break;
      case "ArrowUp":
        this.switcher.move(-1);
        break;
      case "Enter": {
        const match = this.switcher.current();
        if (match) void this.choose(match, isMac() ? event.metaKey : event.ctrlKey);
        else void this.create();
        break;
      }
      case "Escape":
        this.switcher.close();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /** Nothing matches: the query becomes a new note. */
  protected async create(): Promise<void> {
    const query = this.switcher.query();
    if (!query.trim()) return;
    this.switcher.close();
    try {
      await this.ops.createNoteForLink(query);
    } catch (err) {
      this.error.emit(String(err));
    }
  }

  protected async choose(match: SwitcherMatch, newTab = false): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    this.switcher.close();
    try {
      const path = joinPath(root, match.entry.path);
      if (newTab) await this.tabs.openInNewTab(path);
      else await this.doc.open(path);
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}
