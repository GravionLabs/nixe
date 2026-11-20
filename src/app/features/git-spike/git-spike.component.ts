import { Component, inject, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

import { GitService } from "../../core/git/git.service";

const URL_KEY = "nixe.gitSpike.url";

function readUrl(): string {
  try {
    return localStorage.getItem(URL_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveUrl(url: string): void {
  try {
    localStorage.setItem(URL_KEY, url);
  } catch {
    // Storage can be unavailable; the field then starts empty.
  }
}

/** Temporary prototype for #60 (git2 on iOS). Dev builds only; remove after the spike. */
@Component({
  selector: "app-git-spike",
  templateUrl: "./git-spike.component.html",
  styles: `
    .spike {
      padding: 0.5rem 1rem;
      font-size: 0.85rem;
    }
    input {
      display: block;
      width: 100%;
      margin: 0.25rem 0;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem;
    }
    pre {
      white-space: pre-wrap;
    }
  `,
})
export class GitSpikeComponent {
  protected readonly git = inject(GitService);
  protected readonly log = signal("");
  /** The repository URL is remembered between launches (the token lives in the Keychain). */
  protected readonly savedUrl = readUrl();

  protected async run(name: string, action: () => Promise<unknown>): Promise<void> {
    const start = performance.now();
    try {
      const result = await action();
      const text = typeof result === "string" ? result : (JSON.stringify(result) ?? "");
      this.log.update(
        (l) => `${l}${name}: ok ${Math.round(performance.now() - start)} ms ${text}\n`,
      );
    } catch (error) {
      this.log.update((l) => `${l}${name}: FAILED ${String(error)}\n`);
    }
  }

  protected async setToken(input: HTMLInputElement): Promise<void> {
    // Also answers a token prompt raised by a remote operation below.
    await this.git.saveToken(input.value);
    input.value = "";
  }

  protected async hasToken(): Promise<boolean> {
    return this.git.refreshToken().then(() => this.git.tokenStored());
  }

  protected async clone(url: string): Promise<string> {
    saveUrl(url);
    const ms = await this.git.runRemote(() => invoke<number>("git_clone", { url }));
    return `clone took ${ms} ms`;
  }

  protected async commit(): Promise<boolean> {
    await invoke("git_spike_edit");
    return invoke<boolean>("git_commit", { message: "chore: nixe git spike" });
  }

  protected async cmd(name: "git_pull_rebase" | "git_push"): Promise<void> {
    await this.git.runRemote(() => invoke<void>(name));
  }
}
