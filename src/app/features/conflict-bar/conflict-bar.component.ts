import { Component, inject, output } from "@angular/core";

import { ConflictService } from "../../core/git/conflict.service";
import { basename } from "../../core/markdown/paths";

/** Shown above a note that has a sync conflict: links the two versions and settles the pair. */
@Component({
  selector: "app-conflict-bar",
  template: `
    @if (conflict.pair(); as pair) {
      <div class="bar" role="alert">
        <span class="text">
          @if (conflict.isCopy()) {
            This is your version from the sync conflict.
          } @else {
            This note changed on two devices. Your version is saved as
          }
          <a href="#" class="link" (click)="open($event)">{{ basename(conflict.other() ?? "") }}</a>
        </span>
        <button type="button" (click)="keep('this')">Keep this one</button>
        <button type="button" (click)="keep('other')">Keep the other</button>
      </div>
    }
  `,
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
    button {
      height: 24px;
      padding: 0 10px;
      border: 1px solid var(--h-content-border-color);
      border-radius: 6px;
      background: var(--h-content-background);
      color: var(--h-text-color);
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      background: var(--h-surface-hover);
    }
  `,
})
export class ConflictBarComponent {
  protected readonly conflict = inject(ConflictService);
  readonly error = output<string>();
  protected readonly basename = basename;

  protected async open(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(() => this.conflict.openOther());
  }

  protected keep(which: "this" | "other"): Promise<void> {
    return this.run(() => this.conflict.keep(which));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}
