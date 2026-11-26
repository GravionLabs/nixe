import { Injectable, computed, effect, inject, signal } from "@angular/core";
import { HxTheme } from "@gravionlabs/helix-ui";

import { backend } from "../file/backend";
import type { LogLevel } from "../log/log-level";
import type { TreeSort } from "../workspace/tree-model";
import type { LinkPreviewMode } from "../preview/preview-core";
import type { VaultState, VaultStates } from "../workspace/recent-vaults";
import { addRecent, pruneStates, removeRecent } from "../workspace/recent-vaults";
import type {
  CaptureTarget,
  PropertiesDisplay,
  StoredSettings,
  ThemeMode,
  ViewMode,
} from "./settings-core";
import {
  LEGACY_STORAGE_KEY,
  ZOOM_MAX,
  ZOOM_MIN,
  loadSettings,
  sanitizeSettings,
  serializeSettings,
} from "./settings-core";

export { ZOOM_MAX, ZOOM_MIN };
export type { ThemeMode };
export type PanelTab = "outline" | "links" | "related" | "properties";

const ZOOM_STEP = 10;

function readLegacy(): string | null {
  try {
    return localStorage.getItem(LEGACY_STORAGE_KEY);
  } catch {
    return null;
  }
}

@Injectable({ providedIn: "root" })
export class SettingsService {
  private readonly theme = inject(HxTheme);
  private readonly stored: StoredSettings = loadSettings(null, readLegacy()).settings;

  readonly themeMode = signal<ThemeMode>(this.stored.theme);
  /** LaTeX rendering via KaTeX. */
  readonly math = signal<boolean>(this.stored.math);
  readonly sidebarVisible = signal<boolean>(this.stored.sidebar);
  readonly sidebarWidth = signal<number>(this.stored.sidebarWidth);
  /** The id of the view the sidebar shows. */
  readonly activeView = signal<string>(this.stored.activeView);
  /** Right-hand backlinks and outgoing links panel. */
  readonly backlinksVisible = signal<boolean>(this.stored.backlinks);
  /** Right-hand outline panel (the headings of the open note). */
  readonly outlineVisible = signal<boolean>(this.stored.outline);
  /** Width of the right panel; kept per vault (#250). */
  readonly panelWidth = signal<number>(this.stored.panelWidth);
  /**
   * The tab of the right panel. The panel is open when `outlineVisible` or `backlinksVisible` is
   * set; they are stored per vault, so the open tab survives a restart. Both set (an old
   * setting) shows the outline.
   */
  readonly panelTab = computed<PanelTab>(() => {
    if (this.outlineVisible() || !this.backlinksVisible()) return "outline";
    return this.otherSelected() ?? "links";
  });
  /**
   * The Related and Properties tabs share the stored `backlinksVisible` flag with Links: one is
   * open when that flag is set and this names it. Not stored, so a restart reopens the panel on Links.
   */
  private readonly otherSelected = signal<"related" | "properties" | null>(null);
  readonly panelOpen = computed(() => this.outlineVisible() || this.backlinksVisible());

  /** Opens the panel on `tab`. */
  showPanelTab(tab: PanelTab): void {
    this.outlineVisible.set(tab === "outline");
    this.backlinksVisible.set(tab !== "outline");
    this.otherSelected.set(tab === "related" || tab === "properties" ? tab : null);
  }

  /** Opens the panel on `tab`; closes it when that tab is the open one. */
  togglePanelTab(tab: PanelTab): void {
    if (this.panelOpen() && this.panelTab() === tab) {
      this.outlineVisible.set(false);
      this.backlinksVisible.set(false);
    } else this.showPanelTab(tab);
  }

  /** Hover preview of links: with ⌘/Ctrl held, or always. */
  readonly linkPreview = signal<LinkPreviewMode>(this.stored.linkPreview);
  /** Folder reopened on the next start. */
  readonly lastFolder = signal<string | null>(this.stored.lastFolder);
  /** The last vaults opened, newest first. */
  readonly recentVaults = signal<string[]>(this.stored.recentVaults);
  /** Last open note and panel layout of each recent vault, by folder. */
  readonly vaultStates = signal<VaultStates>(this.stored.vaultStates);
  /** Document zoom, as a percentage (100 = actual size). */
  readonly zoom = signal<number>(this.stored.zoom);

  /** Vault-relative folders (templates, archive) the vault health report leaves out. */
  readonly healthExclude = signal<string[]>(this.stored.healthExclude);

  /** Vault-relative template folder, used when `.obsidian/templates.json` names none. */
  readonly templateFolder = signal<string>(this.stored.templateFolder);

  /** Daily notes: used for each key `.obsidian/daily-notes.json` does not set. Empty is the default. */
  readonly dailyFolder = signal<string>(this.stored.dailyFolder);
  readonly dailyFormat = signal<string>(this.stored.dailyFormat);
  readonly dailyTemplate = signal<string>(this.stored.dailyTemplate);

  /** Commit author used when the Git config of the vault has none. */
  readonly gitAuthorName = signal<string>(this.stored.gitAuthorName);
  readonly gitAuthorEmail = signal<string>(this.stored.gitAuthorEmail);
  /** Optional GitHub Enterprise Server host besides github.com. */
  readonly gitEnterpriseHost = signal<string>(this.stored.gitEnterpriseHost);

  /** Automatic sync of the vault; everything is off by default. */
  readonly autoSync = signal<boolean>(this.stored.autoSync);
  readonly autoSyncMinutes = signal<number>(this.stored.autoSyncMinutes);
  readonly autoSyncOnFocus = signal<boolean>(this.stored.autoSyncOnFocus);
  readonly autoSyncOnQuit = signal<boolean>(this.stored.autoSyncOnQuit);

  /** Branches with this prefix that are ahead of the working branch wait for review (#108). */
  readonly reviewBranchPrefix = signal<string>(this.stored.reviewBranchPrefix);

  /** Bookmarks go into `.nixe/bookmarks.json` of the vault instead of the app data (#111). */
  readonly bookmarksInVault = signal<boolean>(this.stored.bookmarksInVault);

  /** Extracting text leaves an embed instead of a link (#113). */
  readonly extractEmbed = signal<boolean>(this.stored.extractEmbed);

  /** Long lines of code blocks wrap instead of scrolling sideways (#245). */
  readonly wrapCode = signal<boolean>(this.stored.wrapCode);

  /** A single click opens a note in the preview tab, a double click in its own tab (#416). */
  readonly previewTabs = signal<boolean>(this.stored.previewTabs);

  /** The mode a new tab shows its note in: live preview, source or reading view (#377). */
  readonly defaultView = signal<ViewMode>(this.stored.defaultView);

  /** Export and print (#119): breaks before top-level headings, the dark look, the page size. */
  readonly exportPageBreaks = signal<boolean>(this.stored.exportPageBreaks);
  readonly exportDark = signal<boolean>(this.stored.exportDark);
  readonly exportPageSize = signal<string>(this.stored.exportPageSize);
  /** How the properties show in the document; folding the panel switches between visible and folded (#290). */
  readonly propertiesDisplay = signal<PropertiesDisplay>(this.stored.propertiesDisplay);

  /** Appearance (#114): the theme file, the enabled snippets, the accent color and the fonts. */
  readonly appearanceTheme = signal<string>(this.stored.appearanceTheme);
  readonly snippets = signal<string[]>(this.stored.snippets);
  readonly accentColor = signal<string>(this.stored.accentColor);
  readonly fontText = signal<string>(this.stored.fontText);
  readonly fontMono = signal<string>(this.stored.fontMono);
  /** Size of the note text in px (#374). */
  readonly textSize = signal<number>(this.stored.textSize);

  /** Order of the file tree (#230). */
  readonly treeSort = signal<TreeSort>(this.stored.treeSort);

  /** The file tree marks changed notes with their Git status (#248). */
  readonly treeGitStatus = signal<boolean>(this.stored.treeGitStatus);

  /** The user's own shortcuts by command id; a command not listed keeps its default, "" is removed. */
  readonly shortcuts = signal<Record<string, string>>(this.stored.shortcuts);

  /** The capture window (#118): its global shortcut ("" is off), the target and the inbox. */
  readonly captureShortcut = signal<string>(this.stored.captureShortcut);
  readonly captureTarget = signal<CaptureTarget>(this.stored.captureTarget);
  readonly captureInbox = signal<string>(this.stored.captureInbox);
  readonly captureTemplate = signal<string>(this.stored.captureTemplate);

  /** The terminal (#360): off by default; the first time it is turned on the user confirms. */
  readonly terminalEnabled = signal<boolean>(this.stored.terminalEnabled);
  readonly logLevel = signal<LogLevel>(this.stored.logLevel);
  readonly terminalConfirmed = signal<boolean>(this.stored.terminalConfirmed);
  readonly terminalVisible = signal<boolean>(this.stored.terminalVisible);
  readonly terminalHeight = signal<number>(this.stored.terminalHeight);

  private readonly systemDark = signal(false);
  readonly dark = computed(
    () => this.themeMode() === "dark" || (this.themeMode() === "system" && this.systemDark()),
  );

  constructor() {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    this.systemDark.set(media.matches);
    media.addEventListener("change", (e) => this.systemDark.set(e.matches));

    // HxTheme owns the one switch (`.app-dark` on <html>) that the tokens, the Markdown and the code styles follow.
    effect(() => this.theme.setDark(this.dark()));

    effect(() => this.persist(this.snapshot()));
  }

  /** Every setting as it is stored. */
  private snapshot(): StoredSettings {
    return {
      theme: this.themeMode(),
      math: this.math(),
      sidebar: this.sidebarVisible(),
      sidebarWidth: this.sidebarWidth(),
      activeView: this.activeView(),
      backlinks: this.backlinksVisible(),
      outline: this.outlineVisible(),
      panelWidth: this.panelWidth(),
      linkPreview: this.linkPreview(),
      lastFolder: this.lastFolder(),
      recentVaults: this.recentVaults(),
      vaultStates: this.vaultStates(),
      zoom: this.zoom(),
      healthExclude: this.healthExclude(),
      templateFolder: this.templateFolder(),
      dailyFolder: this.dailyFolder(),
      dailyFormat: this.dailyFormat(),
      dailyTemplate: this.dailyTemplate(),
      gitAuthorName: this.gitAuthorName(),
      gitAuthorEmail: this.gitAuthorEmail(),
      gitEnterpriseHost: this.gitEnterpriseHost(),
      autoSync: this.autoSync(),
      autoSyncMinutes: this.autoSyncMinutes(),
      autoSyncOnFocus: this.autoSyncOnFocus(),
      autoSyncOnQuit: this.autoSyncOnQuit(),
      reviewBranchPrefix: this.reviewBranchPrefix(),
      bookmarksInVault: this.bookmarksInVault(),
      extractEmbed: this.extractEmbed(),
      wrapCode: this.wrapCode(),
      previewTabs: this.previewTabs(),
      defaultView: this.defaultView(),
      exportPageBreaks: this.exportPageBreaks(),
      exportDark: this.exportDark(),
      exportPageSize: this.exportPageSize(),
      propertiesDisplay: this.propertiesDisplay(),
      appearanceTheme: this.appearanceTheme(),
      snippets: this.snippets(),
      accentColor: this.accentColor(),
      fontText: this.fontText(),
      fontMono: this.fontMono(),
      textSize: this.textSize(),
      treeSort: this.treeSort(),
      treeGitStatus: this.treeGitStatus(),
      shortcuts: this.shortcuts(),
      captureShortcut: this.captureShortcut(),
      captureTarget: this.captureTarget(),
      captureInbox: this.captureInbox(),
      captureTemplate: this.captureTemplate(),
      terminalEnabled: this.terminalEnabled(),
      logLevel: this.logLevel(),
      terminalConfirmed: this.terminalConfirmed(),
      terminalVisible: this.terminalVisible(),
      terminalHeight: this.terminalHeight(),
    };
  }

  /** Puts loaded settings into the signals; they apply at once, without a restart. */
  private apply(s: StoredSettings): void {
    this.themeMode.set(s.theme);
    this.math.set(s.math);
    this.sidebarVisible.set(s.sidebar);
    this.sidebarWidth.set(s.sidebarWidth);
    this.activeView.set(s.activeView);
    this.backlinksVisible.set(s.backlinks);
    this.outlineVisible.set(s.outline);
    this.panelWidth.set(s.panelWidth);
    this.linkPreview.set(s.linkPreview);
    this.lastFolder.set(s.lastFolder);
    this.recentVaults.set(s.recentVaults);
    this.vaultStates.set(s.vaultStates);
    this.zoom.set(s.zoom);
    this.healthExclude.set(s.healthExclude);
    this.templateFolder.set(s.templateFolder);
    this.dailyFolder.set(s.dailyFolder);
    this.dailyFormat.set(s.dailyFormat);
    this.dailyTemplate.set(s.dailyTemplate);
    this.gitAuthorName.set(s.gitAuthorName);
    this.gitAuthorEmail.set(s.gitAuthorEmail);
    this.gitEnterpriseHost.set(s.gitEnterpriseHost);
    this.autoSync.set(s.autoSync);
    this.autoSyncMinutes.set(s.autoSyncMinutes);
    this.autoSyncOnFocus.set(s.autoSyncOnFocus);
    this.autoSyncOnQuit.set(s.autoSyncOnQuit);
    this.reviewBranchPrefix.set(s.reviewBranchPrefix);
    this.bookmarksInVault.set(s.bookmarksInVault);
    this.extractEmbed.set(s.extractEmbed);
    this.wrapCode.set(s.wrapCode);
    this.previewTabs.set(s.previewTabs);
    this.defaultView.set(s.defaultView);
    this.exportPageBreaks.set(s.exportPageBreaks);
    this.exportDark.set(s.exportDark);
    this.exportPageSize.set(s.exportPageSize);
    this.propertiesDisplay.set(s.propertiesDisplay);
    if (s.propertiesDisplay !== "hidden") this.lastShownProperties = s.propertiesDisplay;
    this.appearanceTheme.set(s.appearanceTheme);
    this.snippets.set(s.snippets);
    this.accentColor.set(s.accentColor);
    this.fontText.set(s.fontText);
    this.fontMono.set(s.fontMono);
    this.textSize.set(s.textSize);
    this.treeSort.set(s.treeSort);
    this.treeGitStatus.set(s.treeGitStatus);
    this.shortcuts.set(s.shortcuts);
    this.captureShortcut.set(s.captureShortcut);
    this.captureTarget.set(s.captureTarget);
    this.captureInbox.set(s.captureInbox);
    this.captureTemplate.set(s.captureTemplate);
    this.terminalEnabled.set(s.terminalEnabled);
    this.logLevel.set(s.logLevel);
    this.terminalConfirmed.set(s.terminalConfirmed);
    this.terminalVisible.set(s.terminalVisible);
    this.terminalHeight.set(s.terminalHeight);
  }

  /** True once the settings file is known to be readable; only then it is written. */
  private fileReady = false;
  private writing: Promise<void> = Promise.resolve();

  /**
   * Reads the settings file of the app config directory (called before the app starts). Without
   * one, the old `localStorage` entry is migrated into it. When the file cannot be read the
   * settings stay in `localStorage`, so a failure never overwrites the file.
   */
  async load(): Promise<void> {
    let file: string | null;
    try {
      file = await backend.readAppSettings();
    } catch (err) {
      console.warn("settings file unavailable, using local storage", err);
      return;
    }
    const { settings, source, damaged } = loadSettings(file, readLegacy());
    this.apply(settings);
    if (damaged) {
      // Keep the damaged file for the user to recover; settings go to local storage meanwhile.
      console.warn("settings.json is damaged and was left untouched");
      return;
    }
    this.fileReady = true;
    if (source !== "file") this.persist(settings);
  }

  private persist(settings: StoredSettings): void {
    if (!this.fileReady) {
      try {
        localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // storage unavailable – settings just aren't persisted
      }
      return;
    }
    const content = serializeSettings(sanitizeSettings(settings));
    // Writes run one after the other, so the last change is the one that stays.
    this.writing = this.writing
      .then(() => backend.writeAppSettings(content))
      .then(() => {
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          // ignore
        }
      })
      .catch((err) => console.warn("settings not saved", err));
  }

  /** Writes the settings as they are now, without waiting for the effect, and resolves when done. */
  save(): Promise<void> {
    this.persist(this.snapshot());
    return this.writing;
  }

  /** Resolves when the writes started so far are done. */
  flush(): Promise<void> {
    return this.writing;
  }

  /** Puts a vault at the top of the recent list. */
  noteVaultOpened(path: string): void {
    this.recentVaults.update((list) => addRecent(list, path));
    this.vaultStates.update((states) => pruneStates(states, this.recentVaults()));
  }

  forgetVault(path: string): void {
    this.recentVaults.update((list) => removeRecent(list, path));
    this.vaultStates.update((states) => pruneStates(states, this.recentVaults()));
    if (this.lastFolder() === path) this.lastFolder.set(null);
  }

  rememberVaultState(path: string, state: VaultState): void {
    if (!this.recentVaults().includes(path)) return;
    this.vaultStates.update((states) => ({ ...states, [path]: state }));
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

  /** Folds or unfolds the properties in the document; hidden properties come back unfolded. */
  foldProperties(): void {
    this.propertiesDisplay.update((m) => (m === "visible" ? "folded" : "visible"));
  }

  /** The state the properties return to when the toolbar toggle switches them on again (#406). */
  private lastShownProperties: Exclude<PropertiesDisplay, "hidden"> =
    this.stored.propertiesDisplay === "visible" ? "visible" : "folded";

  /** Switches the properties in the document off, or on again in the state they had before. */
  toggleProperties(): void {
    const current = this.propertiesDisplay();
    if (current === "hidden") {
      this.propertiesDisplay.set(this.lastShownProperties);
    } else {
      this.lastShownProperties = current;
      this.propertiesDisplay.set("hidden");
    }
  }

  resetZoom(): void {
    this.zoom.set(100);
  }
}
