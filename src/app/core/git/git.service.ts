import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { GitStatus, backend } from "../file/backend";
import { IndexService } from "../index/index.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";

/** Git state of the vault. `status` stays null for a vault without a repository: no Git UI then. */
@Injectable({ providedIn: "root" })
export class GitService {
  private readonly workspace = inject(WorkspaceService);
  private readonly index = inject(IndexService);
  private readonly settings = inject(SettingsService);

  readonly visible = signal(false);
  readonly status = signal<GitStatus | null>(null);
  readonly committing = signal(false);
  private request = 0;

  /** True when the vault is a Git repository. */
  readonly available = computed(() => this.workspace.vaultRoot() !== null && this.status() !== null);

  constructor() {
    // The vault changed on disk (or another vault was opened): read the state again.
    effect(() => {
      this.workspace.vaultRoot();
      this.index.revision();
      untracked(() => void this.refresh());
    });
  }

  open(): void {
    if (this.available()) this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }

  /** A newer call wins over an older one still running. */
  async refresh(): Promise<void> {
    const request = ++this.request;
    if (this.workspace.vaultRoot() === null) {
      this.status.set(null);
      this.visible.set(false);
      return;
    }
    let status: GitStatus | null;
    try {
      status = await backend.gitVaultStatus();
    } catch {
      status = null;
    }
    if (request !== this.request) return;
    this.status.set(status);
    if (status === null) this.visible.set(false);
  }

  /**
   * Commits all changes. An empty message gives the default of the backend.
   * Throws the error message of the backend (for example "nothing to commit").
   */
  async commit(message: string): Promise<void> {
    this.committing.set(true);
    try {
      await backend.gitVaultCommit(
        message.trim() || null,
        this.settings.gitAuthorName().trim() || null,
        this.settings.gitAuthorEmail().trim() || null,
      );
    } finally {
      this.committing.set(false);
      await this.refresh();
    }
  }
}
