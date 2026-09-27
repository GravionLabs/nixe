import { Injectable, computed, effect, signal } from "@angular/core";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "nixe.settings";

interface StoredSettings {
  theme: ThemeMode;
  math: boolean;
  sidebar: boolean;
  sidebarWidth: number;
  lastFolder: string | null;
}

const DEFAULTS: StoredSettings = {
  theme: "system",
  math: true,
  sidebar: true,
  sidebarWidth: 260,
  lastFolder: null,
};

function loadSettings(): StoredSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

@Injectable({ providedIn: "root" })
export class SettingsService {
  private readonly stored = loadSettings();

  readonly themeMode = signal<ThemeMode>(this.stored.theme);
  /** LaTeX rendering via KaTeX. */
  readonly math = signal<boolean>(this.stored.math);
  readonly sidebarVisible = signal<boolean>(this.stored.sidebar);
  readonly sidebarWidth = signal<number>(this.stored.sidebarWidth);
  /** Folder reopened on the next start. */
  readonly lastFolder = signal<string | null>(this.stored.lastFolder);

  private readonly systemDark = signal(false);
  readonly dark = computed(
    () => this.themeMode() === "dark" || (this.themeMode() === "system" && this.systemDark()),
  );

  constructor() {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    this.systemDark.set(media.matches);
    media.addEventListener("change", (e) => this.systemDark.set(e.matches));

    effect(() => {
      document.documentElement.dataset["theme"] = this.dark() ? "dark" : "light";
    });

    effect(() => {
      const settings: StoredSettings = {
        theme: this.themeMode(),
        math: this.math(),
        sidebar: this.sidebarVisible(),
        sidebarWidth: this.sidebarWidth(),
        lastFolder: this.lastFolder(),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // storage unavailable – settings just aren't persisted
      }
    });
  }

  cycleTheme(): void {
    const order: ThemeMode[] = ["system", "light", "dark"];
    this.themeMode.update((m) => order[(order.indexOf(m) + 1) % order.length]);
  }
}
