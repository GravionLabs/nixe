import { Component, ElementRef, effect, inject, output, viewChild } from "@angular/core";

import { DocumentService } from "../../core/file/document.service";
import { joinPath } from "../../core/markdown/paths";
import { SwitcherMatch } from "../../core/switcher/fuzzy";
import { SwitcherService } from "../../core/switcher/switcher.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** Quick switcher overlay: type a few letters, arrow keys to choose, Enter to open. */
@Component({
  selector: "app-switcher",
  templateUrl: "./switcher.component.html",
  styleUrl: "./switcher.component.css",
})
export class SwitcherComponent {
  protected readonly switcher = inject(SwitcherService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);

  readonly error = output<string>();
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("input");

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
        // Without a match nothing happens yet (creating a note comes with the editor).
        const match = this.switcher.current();
        if (match) void this.choose(match);
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

  protected async choose(match: SwitcherMatch): Promise<void> {
    const root = this.workspace.vaultRoot();
    if (!root) return;
    this.switcher.close();
    try {
      await this.doc.open(joinPath(root, match.entry.path));
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}
