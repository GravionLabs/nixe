import { Component, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

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
  template: `
    <details class="spike">
      <summary>Git spike (#60)</summary>
      <input #url [value]="savedUrl" placeholder="https://github.com/owner/private-repo.git" />
      <input #token type="password" placeholder="personal access token" />
      <div class="row">
        <button type="button" (click)="run('token set', () => setToken(token))">Save token</button>
        <button type="button" (click)="run('token get', () => hasToken())">Token?</button>
        <button type="button" (click)="run('clone', () => clone(url.value))">Clone</button>
        <button type="button" (click)="run('commit', () => commit())">Commit</button>
        <button type="button" (click)="run('pull --rebase', () => cmd('git_pull_rebase'))">Pull</button>
        <button type="button" (click)="run('push', () => cmd('git_push'))">Push</button>
      </div>
      <pre>{{ log() }}</pre>
    </details>
  `,
  styles: `
    .spike { padding: 0.5rem 1rem; font-size: 0.85rem; }
    input { display: block; width: 100%; margin: 0.25rem 0; }
    .row { display: flex; flex-wrap: wrap; gap: 0.25rem; }
    pre { white-space: pre-wrap; }
  `,
})
export class GitSpikeComponent {
  protected readonly log = signal("");
  /** The repository URL is remembered between launches (the token lives in the Keychain). */
  protected readonly savedUrl = readUrl();

  protected async run(name: string, action: () => Promise<unknown>): Promise<void> {
    const start = performance.now();
    try {
      const result = await action();
      this.log.update((l) => `${l}${name}: ok ${Math.round(performance.now() - start)} ms ${result ?? ""}\n`);
    } catch (error) {
      this.log.update((l) => `${l}${name}: FAILED ${String(error)}\n`);
    }
  }

  protected async setToken(input: HTMLInputElement): Promise<void> {
    await invoke("git_token_set", { host: "github.com", token: input.value });
    input.value = "";
  }

  protected async hasToken(): Promise<boolean> {
    return invoke<boolean>("git_token_status", { host: "github.com" });
  }

  protected async clone(url: string): Promise<string> {
    saveUrl(url);
    const ms = await invoke<number>("git_clone", { url });
    return `clone took ${ms} ms`;
  }

  protected async commit(): Promise<boolean> {
    await invoke("git_spike_edit");
    return invoke<boolean>("git_commit", { message: "chore: nixe git spike" });
  }

  protected async cmd(name: "git_pull_rebase" | "git_push"): Promise<void> {
    await invoke(name);
  }
}
