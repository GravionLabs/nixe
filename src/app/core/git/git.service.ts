import { Injectable, computed, effect, inject, signal, untracked } from "@angular/core";

import type { GitStatus, SyncReport } from "../file/backend";
import { backend } from "../file/backend";
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

export interface SyncState {
  phase: "idle" | "syncing" | "done" | "error";
  message: string;
  /** The text of the backend behind a failure; the panel keeps it reachable. */
  detail?: string;
}

/** What a failed sync means and what to do, in plain words. The raw text goes to `detail`. */
export function explainSyncError(raw: string): string {
  if (AUTH_ERROR.test(raw))
    return "GitHub needs a valid access token. Add one in the sync settings.";
  if (/conflict/i.test(raw))
    return "Some notes were changed in two places and could not be joined. Nothing is lost; try again.";
  if (/no author|user\.name|user\.email/i.test(raw))
    return "Your name and email are missing. Add them under Author in the sync settings.";
  if (/network|resolve|connect|timed? ?out|unreachable|offline|dns/i.test(raw))
    return "The server could not be reached. Check your connection and try again.";
  if (/no remote|remote.*not|upstream/i.test(raw))
    return "This vault has no place to send versions to yet. Connect it first.";
  return "Syncing did not work. Your notes are safe on this computer; try again later.";
}

/** A readable line for what a sync did. */
export function describeSync(report: SyncReport): string {
  const parts = [
    report.committed ? "saved" : "",
    report.pulled ? "received" : "",
    report.pushed ? "sent" : "",
  ].filter(Boolean);
  const n = report.conflicts?.length ?? 0;
  const text = parts.length ? `Synced (${parts.join(", ")})` : "Everything is synced";
  return n > 0
    ? `${text}; ${n} ${n === 1 ? "note" : "notes"} changed on both sides, both versions kept`
    : text;
}

/** Git state of the vault. `status` stays null for a vault without a repository: no Git UI then. */
@Injectable({ providedIn: "root" })
export class GitService {
  private readonly workspace = inject(WorkspaceService);
  private readonly index = inject(IndexService);
  private readonly settings = inject(SettingsService);

  readonly status = signal<GitStatus | null>(null);
  readonly committing = signal(false);
  /** Whether a token is stored for `GIT_HOST`. The token itself is never read into the frontend. */
  readonly tokenStored = signal(false);
  /** Set while a remote operation waits for a token. */
  readonly tokenPrompt = signal<TokenPrompt | null>(null);
  /** Progress and result of the last sync, for the status bar. */
  readonly syncState = signal<SyncState>({ phase: "idle", message: "" });
  /** When the last sync of this session succeeded (ms since the epoch); null before one. */
  readonly lastSynced = signal<number | null>(null);
  /** The last pull that brought changes: the commit HEAD was at before it. A new object per pull. */
  readonly lastPull = signal<{ from: string } | null>(null);
  private request = 0;
  /** The last sync error that was shown; an automatic sync does not show it again. */
  private lastError: string | null = null;
  private promptResult: ((token: string | null) => void) | null = null;

  /** True when the vault is a Git repository. */
  readonly available = computed(
    () => this.workspace.vaultRoot() !== null && this.status() !== null,
  );

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

  /** A newer call wins over an older one still running. */
  async refresh(): Promise<void> {
    const request = ++this.request;
    if (this.workspace.vaultRoot() === null) {
      this.status.set(null);
      return;
    }
    let status: GitStatus | null;
    try {
      status = await backend.gitVaultStatus();
    } catch {
      status = null;
    }
    if (request !== this.request) return;
    // An unchanged status keeps its object, so nothing downstream reloads (#289).
    if (JSON.stringify(status) !== JSON.stringify(this.status())) this.status.set(status);
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

  /**
   * Saves the open changes with the message (empty: the automatic one), then syncs when the vault
   * has a remote. Throws when saving fails; a failed sync shows in `syncState`.
   */
  async saveAndSync(message: string): Promise<void> {
    const status = this.status();
    if (status && status.changes.length > 0) await this.commit(message);
    if (this.status()?.hasRemote) await this.sync();
  }

  /**
   * Brings the vault in line with the remote: commits open changes, rebases onto the remote
   * branch and pushes. Progress and result are in `syncState`; never throws. The backend
   * leaves the repository clean on every failure. The index and the open note follow the
   * pulled files through the watcher.
   *
   * An automatic sync (`auto`) never asks for a token and shows an error only when it differs
   * from the one already shown, so a failing remote does not repeat on every interval.
   */
  async sync(options: { auto?: boolean } = {}): Promise<void> {
    if (!this.available() || this.syncState().phase === "syncing") return;
    const auto = options.auto === true;
    const before = this.syncState();
    this.syncState.set({ phase: "syncing", message: "Syncing…" });
    const call = () =>
      backend.gitVaultSync(
        this.settings.gitAuthorName().trim() || null,
        this.settings.gitAuthorEmail().trim() || null,
      );
    try {
      const report = await (auto ? call() : this.runRemote(call));
      this.lastError = null;
      if (report.pulled && report.pulledFrom) this.lastPull.set({ from: report.pulledFrom });
      this.lastSynced.set(Date.now());
      this.syncState.set({ phase: "done", message: describeSync(report) });
    } catch (err) {
      const text = String(err instanceof Error ? err.message : err).replace(/^Error: /, "");
      const message = `Sync failed: ${explainSyncError(text)}`;
      if (auto && text === this.lastError) this.syncState.set(before);
      else this.syncState.set({ phase: "error", message, detail: text });
      this.lastError = text;
    } finally {
      await this.refresh();
    }
  }
}
