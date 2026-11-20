import { Injectable, effect, inject, signal } from "@angular/core";

import { backend } from "../file/backend";
import { SettingsService } from "../settings/settings.service";
import { CssFile, RELOAD_MS, changed, enabledSnippets, overridesCss } from "./appearance-core";

const IDS = { theme: "nixe-theme", overrides: "nixe-overrides", snippets: "nixe-snippets" } as const;

/**
 * Applies the theme, the CSS snippets, the accent color and the fonts (#114). The CSS goes into
 * `<style>` elements of the document head, so the theme comes after the app styles, the snippets
 * after the theme and the settings last. The files are read again every few seconds while the
 * window is visible, so an edit shows up without any action.
 */
@Injectable({ providedIn: "root" })
export class AppearanceService {
  private readonly settings = inject(SettingsService);

  readonly themes = signal<CssFile[]>([]);
  readonly snippets = signal<CssFile[]>([]);
  /** The app config directory that holds `themes/` and `snippets/`; empty before it is known. */
  readonly folder = signal("");
  /** Set when the files cannot be read. */
  readonly error = signal<string | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const name = this.settings.appearanceTheme();
      const theme = this.themes().find((t) => t.name === name);
      this.style(IDS.theme, theme?.css ?? "");
    });
    effect(() => {
      const on = enabledSnippets(this.snippets(), this.settings.snippets());
      this.style(IDS.snippets, on.map((f) => f.css).join("\n"));
    });
    effect(() =>
      this.style(IDS.overrides, overridesCss(this.settings.accentColor(), this.settings.fontText(), this.settings.fontMono())),
    );
  }

  /** Reads the files once and watches them from now on. */
  async start(): Promise<void> {
    try {
      this.folder.set(await backend.appearanceDir());
    } catch {
      // the folder is only shown
    }
    await this.refresh();
    if (this.timer === null) {
      this.timer = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState !== "hidden") void this.refresh();
      }, RELOAD_MS);
    }
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reads `themes/` and `snippets/`; only a change updates the signals. */
  async refresh(): Promise<void> {
    try {
      const [themes, snippets] = await Promise.all([backend.readAppearance("themes"), backend.readAppearance("snippets")]);
      if (changed(this.themes(), themes)) this.themes.set(themes);
      if (changed(this.snippets(), snippets)) this.snippets.set(snippets);
      this.error.set(null);
    } catch (err) {
      this.error.set(String(err));
    }
  }

  private style(id: string, css: string): void {
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!css) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      document.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }
}
