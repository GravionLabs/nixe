import { Injectable, computed, effect, signal } from "@angular/core";

import { clampMinutes } from "../git/auto-sync";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "nixe.settings";

interface StoredSettings {
  theme: ThemeMode;
  math: boolean;
  sidebar: boolean;
  sidebarWidth: number;
  backlinks: boolean;
  lastFolder: string | null;
  zoom: number;
  healthExclude: string[];
  templateFolder: string;
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  autoSync: boolean;
  autoSyncMinutes: number;
  autoSyncOnFocus: boolean;
  autoSyncOnQuit: boolean;
}

const DEFAULTS: StoredSettings = {
  theme: "system",
  math: true,
  sidebar: true,
  sidebarWidth: 260,
  backlinks: false,
  lastFolder: null,
  zoom: 100,
  healthExclude: [],
  templateFolder: "",
  dailyFolder: "",
  dailyFormat: "",
  dailyTemplate: "",
  gitAuthorName: "",
  gitAuthorEmail: "",
  autoSync: false,
  autoSyncMinutes: 10,
  autoSyncOnFocus: false,
  autoSyncOnQuit: false,
};

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;
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
  /** Right-hand backlinks and outgoing links panel. */
  readonly backlinksVisible = signal<boolean>(this.stored.backlinks);
  /** Folder reopened on the next start. */
  readonly lastFolder = signal<string | null>(this.stored.lastFolder);
  /** Document zoom, as a percentage (100 = actual size). */
  readonly zoom = signal<number>(this.stored.zoom);

  /** Vault-relative folders (templates, archive) the vault health report leaves out. */
  readonly healthExclude = signal<string[]>(
    Array.isArray(this.stored.healthExclude) ? this.stored.healthExclude : [],
  );

  /** Vault-relative template folder, used when `.obsidian/templates.json` names none. */
  readonly templateFolder = signal<string>(
    typeof this.stored.templateFolder === "string" ? this.stored.templateFolder : "",
  );

  /** Daily notes: used for each key `.obsidian/daily-notes.json` does not set. Empty is the default. */
  readonly dailyFolder = signal<string>(typeof this.stored.dailyFolder === "string" ? this.stored.dailyFolder : "");
  readonly dailyFormat = signal<string>(typeof this.stored.dailyFormat === "string" ? this.stored.dailyFormat : "");
  readonly dailyTemplate = signal<string>(typeof this.stored.dailyTemplate === "string" ? this.stored.dailyTemplate : "");

  /** Commit author used when the Git config of the vault has none. */
  readonly gitAuthorName = signal<string>(
    typeof this.stored.gitAuthorName === "string" ? this.stored.gitAuthorName : "",
  );
  readonly gitAuthorEmail = signal<string>(
    typeof this.stored.gitAuthorEmail === "string" ? this.stored.gitAuthorEmail : "",
  );

  /** Automatic sync of the vault; everything is off by default. */
  readonly autoSync = signal<boolean>(this.stored.autoSync === true);
  readonly autoSyncMinutes = signal<number>(clampMinutes(Number(this.stored.autoSyncMinutes)));
  readonly autoSyncOnFocus = signal<boolean>(this.stored.autoSyncOnFocus === true);
  readonly autoSyncOnQuit = signal<boolean>(this.stored.autoSyncOnQuit === true);

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
        backlinks: this.backlinksVisible(),
        lastFolder: this.lastFolder(),
        zoom: this.zoom(),
        healthExclude: this.healthExclude(),
        templateFolder: this.templateFolder(),
        dailyFolder: this.dailyFolder(),
        dailyFormat: this.dailyFormat(),
        dailyTemplate: this.dailyTemplate(),
        gitAuthorName: this.gitAuthorName(),
        gitAuthorEmail: this.gitAuthorEmail(),
        autoSync: this.autoSync(),
        autoSyncMinutes: this.autoSyncMinutes(),
        autoSyncOnFocus: this.autoSyncOnFocus(),
        autoSyncOnQuit: this.autoSyncOnQuit(),
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
