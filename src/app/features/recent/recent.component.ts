import type { ElementRef } from "@angular/core";
import { Component, effect, inject, viewChild } from "@angular/core";
import { HxDialog } from "@gravionlabs/helix-ui";

import { basename } from "../../core/markdown/paths";
import { RecentPickerService } from "../../core/workspace/recent-picker.service";

/** Recent vaults overlay: arrow keys to choose, Enter to open. */
@Component({
  selector: "app-recent",
  templateUrl: "./recent.component.html",
  styleUrl: "./recent.component.css",
  imports: [HxDialog],
})
export class RecentComponent {
  protected readonly picker = inject(RecentPickerService);
  private readonly list = viewChild<ElementRef<HTMLElement>>("list");

  constructor() {
    effect(() => this.list()?.nativeElement.focus());
  }

  protected name(path: string): string {
    return basename(path);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        this.picker.move(1);
        break;
      case "ArrowUp":
        this.picker.move(-1);
        break;
      case "Enter": {
        const path = this.picker.current();
        if (path) void this.picker.choose(path);
        break;
      }
      case "Escape":
        this.picker.close();
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
