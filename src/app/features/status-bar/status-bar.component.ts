import { Component, inject } from "@angular/core";

import { GitService } from "../../core/git/git.service";

/** Bottom bar; shows the Git state of the vault, and nothing for a vault without a repository. */
@Component({
  selector: "app-status-bar",
  template: `
    @if (git.status(); as status) {
      <button
        type="button"
        class="git"
        [attr.aria-label]="'Git: ' + (status.branch ?? 'detached HEAD')"
        title="Show the Git changes"
        (click)="git.visible() ? git.close() : git.open()"
      >
        <span class="branch">⎇ {{ status.branch ?? "detached HEAD" }}</span>
        <span class="changes">{{ status.changes.length }} changed</span>
        <span class="sync">↑{{ status.ahead }} ↓{{ status.behind }}</span>
      </button>
      <button
        type="button"
        class="sync-button"
        aria-label="Sync with the remote"
        title="Commit, pull with rebase and push"
        [disabled]="git.syncState().phase === 'syncing'"
        (click)="git.sync()"
      >
        ⟳ Sync
      </button>
      @if (git.syncState().message; as message) {
        <span class="result" role="status" [class.error]="git.syncState().phase === 'error'">{{ message }}</span>
      }
    }
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      min-height: 22px;
      padding: 0 8px;
      border-top: 1px solid var(--border);
      background: var(--chrome);
      color: var(--muted);
      font-size: 12px;
    }

    button {
      display: flex;
      gap: 12px;
      padding: 2px 4px;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    .result.error {
      color: var(--error-fg);
    }

    .result {
      margin-left: 8px;
    }

    button:disabled {
      cursor: progress;
    }

    button:hover:not(:disabled) {
      background: var(--hover);
    }
  `,
})
export class StatusBarComponent {
  protected readonly git = inject(GitService);
}
