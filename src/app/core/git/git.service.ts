import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import { GitStatus, backend } from "../file/backend";
import { IndexService } from "../index/index.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";

/** Remotes are GitHub over HTTPS; the token is keyed by this host. */
export const GIT_HOST = "github.com";

const AUTH_ERROR = /^auth-(required|failed):/;

/** The backend wants a token: none is stored (`required`) or the server refused it (`failed`). */
export interface TokenPrompt {
  reason: "required" | "failed";
}

/** Git state of the vault. `status` stays null for a vault without a repository: no Git UI then. */
@Injectable({ providedIn: "root" })
export class GitService {
  private readonly workspace = inject(WorkspaceService);
  private readonly index = inject(IndexService);
  private readonly settings = inject(SettingsService);

  readonly visible = signal(false);
  readonly status = signal<GitStatus | null>(null);
  readonly committing = signal(false);
  /** Whether a token is stored for `GIT_HOST`. The token itself is never read into the frontend. */
  readonly tokenStored = signal(false);
  /** Set while a remote operation waits for a token. */
  readonly tokenPrompt = signal<TokenPrompt | null>(null);
  private request = 0;
  private promptResult: ((token: string | null) => void) | null = null;

  /** True when the vault is a Git repository. */
  readonly available = computed(() => this.workspace.vaultRoot() !== null && this.status() !== null);

  constructor() {
    // The vault changed on disk (or another vault was opened): read the state again.
    effect(() => {
      this.workspace.vaultRoot();
      this.index.revision();
      untracked(() => void this.refresh());
    });
    void this.refreshToken();
  }

  async refreshToken(): Promise<void> {
    try {
      this.tokenStored.set(await backend.gitTokenStatus(GIT_HOST));
    } catch {
      this.tokenStored.set(false);
    }
  }

  /** Stores or replaces the token. Answers a waiting prompt. */
  async saveToken(token: string): Promise<void> {
    const value = token.trim();
    if (!value) throw new Error("the token is empty");
    await backend.gitTokenSet(GIT_HOST, value);
    this.tokenStored.set(true);
    this.answerPrompt(value);
  }

  async deleteToken(): Promise<void> {
    await backend.gitTokenDelete(GIT_HOST);
    this.tokenStored.set(false);
  }

  /** Dismisses the prompt; the waiting operation fails with its original error. */
  cancelTokenPrompt(): void {
    this.answerPrompt(null);
  }

  private answerPrompt(token: string | null): void {
    const answer = this.promptResult;
    this.promptResult = null;
    this.tokenPrompt.set(null);
    answer?.(token);
  }

  /**
   * Runs a remote operation. When the backend reports a missing or rejected token, asks for
   * one and runs the operation again with it (asks again if that one is rejected too).
   */
  async runRemote<T>(operation: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await operation();
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        const match = AUTH_ERROR.exec(message.replace(/^Error: /, ""));
        if (!match) throw err;
        this.cancelTokenPrompt();
        this.tokenPrompt.set({ reason: match[1] === "failed" ? "failed" : "required" });
        const token = await new Promise<string | null>((resolve) => (this.promptResult = resolve));
        if (token === null) throw err;
      }
    }
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
