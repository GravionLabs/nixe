import { Component, inject, output } from "@angular/core";
import { HxButton } from "@gravionlabs/helix-ui";

import { ConflictService } from "../../core/git/conflict.service";
import { basename } from "../../core/markdown/paths";
import { ConflictMergeComponent } from "./conflict-merge.component";

/** Shown above a note that has a sync conflict: links the two versions and settles the pair. */
@Component({
  selector: "app-conflict-bar",
  imports: [ConflictMergeComponent, HxButton],
  templateUrl: "./conflict-bar.component.html",
  styles: `
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-bottom: 1px solid var(--h-content-border-color);
      background: var(--h-surface-frame);
      color: var(--h-text-color);
      font-size: 12px;
    }
    .text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .link {
      color: var(--h-primary-color);
    }
  `,
})
export class ConflictBarComponent {
  protected readonly conflict = inject(ConflictService);
  readonly failed = output<string>();
  protected readonly basename = basename;

  protected async open(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(() => this.conflict.openOther());
  }

  protected keep(which: "this" | "other"): Promise<void> {
    return this.run(() => this.conflict.keep(which));
  }

  protected merge(): Promise<void> {
    return this.run(() => this.conflict.startMerge());
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}
