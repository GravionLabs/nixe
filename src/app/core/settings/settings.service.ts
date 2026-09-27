import { Injectable, computed, effect, signal } from "@angular/core";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "nixe.settings";

interface StoredSettings {
  theme: ThemeMode;
  math: boolean;
  sidebar: boolean;
  sidebarWidth: number;
  lastFolder: string | null;
  zoom: number;
}

const DEFAULTS: StoredSettings = {
  theme: "system",
  math: true,
  sidebar: true,
  sidebarWidth: 260,
  lastFolder: null,
  zoom: 100,
};

const ZOOM_MIN = 50;
const ZOOM_MAX = 300;
const ZOOM_STEP = 10;

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
  /** Document zoom, as a percentage (100 = actual size). */
  readonly zoom = signal<number>(this.stored.zoom);

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
        zoom: this.zoom(),
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

  zoomIn(): void {
    this.zoom.update((z) => Math.min(ZOOM_MAX, z + ZOOM_STEP));
  }

  zoomOut(): void {
    this.zoom.update((z) => Math.max(ZOOM_MIN, z - ZOOM_STEP));
  }

  resetZoom(): void {
    this.zoom.set(100);
  }
}
