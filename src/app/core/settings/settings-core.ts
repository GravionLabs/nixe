import {
  defaultTextSize,
  detectPlatform,
  sanitizeAccent,
  sanitizeFont,
  sanitizeNames,
  sanitizeTextSize,
} from "../appearance/appearance-core";
import { sanitizePageSize } from "../export/export-core";
import { sanitizeShortcuts } from "../commands/shortcuts-core";
import { clampMinutes } from "../git/auto-sync";
import { DEFAULT_PANEL_WIDTH, sanitizePanelWidth } from "../panel/panel-width";
import { DEFAULT_TERMINAL_HEIGHT, sanitizeTerminalHeight } from "../terminal/terminal-height";
import type { LinkPreviewMode } from "../preview/preview-core";
import { sanitizeMode } from "../preview/preview-core";
import type { TreeSort } from "../workspace/tree-model";
import { sanitizeTreeSort } from "../workspace/tree-model";
import type { VaultStates } from "../workspace/recent-vaults";
import { sanitizeRecent, sanitizeStates } from "../workspace/recent-vaults";

export type ThemeMode = "system" | "light" | "dark";

export type PropertiesDisplay = "visible" | "folded" | "hidden";

export function sanitizePropertiesDisplay(value: unknown): PropertiesDisplay {
  return value === "folded" || value === "hidden" ? value : "visible";
}

/** Key of the settings in `localStorage` before they moved to the app config directory. */
export const LEGACY_STORAGE_KEY = "nixe.settings";

export const ZOOM_MIN = 50;
export const ZOOM_MAX = 300;

/** Everything the app persists, as it is written to `settings.json` in the app config directory. */
export interface StoredSettings {
  theme: ThemeMode;
  math: boolean;
  sidebar: boolean;
  sidebarWidth: number;
  /** The id of the view the sidebar shows (the views registry). */
  activeView: string;
  backlinks: boolean;
  outline: boolean;
  /** Width of the right panel of the open vault, in px. */
  panelWidth: number;
  linkPreview: LinkPreviewMode;
  lastFolder: string | null;
  recentVaults: string[];
  vaultStates: VaultStates;
  zoom: number;
  healthExclude: string[];
  templateFolder: string;
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** Host of a GitHub Enterprise Server that may receive the token, e.g. `ghe.example.com`. */
  gitEnterpriseHost: string;
  autoSync: boolean;
  autoSyncMinutes: number;
  autoSyncOnFocus: boolean;
  autoSyncOnQuit: boolean;
  /** Branches with this prefix that are ahead of the working branch wait for review (#108); empty turns it off. */
  reviewBranchPrefix: string;
  /** Bookmarks are written into `.obsidian/bookmarks.json` of the vault (#111); off keeps them in the app data. */
  bookmarksInVault: boolean;
  /** Extracting text leaves an embed (`![[note]]`) instead of a link (#113). */
  extractEmbed: boolean;
  /** Long lines of code blocks wrap instead of scrolling sideways (#245). */
  wrapCode: boolean;
  /** The editor shows the plain Markdown source instead of the live preview (#243). */
  sourceMode: boolean;
  /** Export and print: a page break before every top-level heading (#119). */
  exportPageBreaks: boolean;
  /** Export and print in the dark look (#119). */
  exportDark: boolean;
  /** Page size of a PDF or print: A3, A4, A5, Letter or Legal (#119). */
  exportPageSize: string;
  /** How the properties of a note show in the document: all, one summary line or not at all (#290). */
  propertiesDisplay: PropertiesDisplay;
  /** Name of the theme file (without `.css`) in `themes/` of the app config directory; "" is the built-in look (#114). */
  appearanceTheme: string;
  /** Names of the enabled snippets of `snippets/` (#114). */
  snippets: string[];
  /** Accent color as `#rrggbb`; "" keeps the default (#114). */
  accentColor: string;
  /** Font families of the text and of the code; "" keeps the default (#114). */
  fontText: string;
  fontMono: string;
  /** Size of the note text in px, before the zoom (#374). */
  textSize: number;
  /** Order of the file tree (#230). */
  treeSort: TreeSort;
  /** The file tree shows the Git status of the notes (#248). */
  treeGitStatus: boolean;
  /** Shortcut of a command id that differs from its default; "" means removed. */
  shortcuts: Record<string, string>;
  /** Global shortcut (Tauri accelerator) that opens the capture window; "" turns capture off (#118). */
  captureShortcut: string;
  /** Where a capture goes: today's daily note or a new note in the inbox folder. */
  captureTarget: CaptureTarget;
  /** Vault-relative inbox folder; "" uses the new-note folder of the vault, else `Inbox`. */
  captureInbox: string;
  /** Vault-relative template note of a new inbox note; `{{content}}` marks the text. */
  captureTemplate: string;
  /** The terminal may be used (#360); off by default, because it runs commands with the rights of the user. */
  terminalEnabled: boolean;
  /** The user has confirmed once that the terminal runs arbitrary code. */
  terminalConfirmed: boolean;
  /** The bottom panel with the terminal is shown. */
  terminalVisible: boolean;
  /** Height of the bottom panel, in px. */
  terminalHeight: number;
}

export type CaptureTarget = "daily" | "inbox";

export const DEFAULT_SETTINGS: StoredSettings = {
  theme: "system",
  math: true,
  sidebar: true,
  sidebarWidth: 260,
  activeView: "files",
  backlinks: false,
  outline: false,
  panelWidth: DEFAULT_PANEL_WIDTH,
  linkPreview: "modifier",
  lastFolder: null,
  recentVaults: [],
  vaultStates: {},
  zoom: 100,
  healthExclude: [],
  templateFolder: "",
  dailyFolder: "",
  dailyFormat: "",
  dailyTemplate: "",
  gitAuthorName: "",
  gitAuthorEmail: "",
  gitEnterpriseHost: "",
  autoSync: false,
  autoSyncMinutes: 10,
  autoSyncOnFocus: false,
  autoSyncOnQuit: false,
  reviewBranchPrefix: "claude/",
  bookmarksInVault: false,
  extractEmbed: false,
  wrapCode: false,
  sourceMode: false,
  exportPageBreaks: true,
  exportDark: false,
  exportPageSize: "A4",
  propertiesDisplay: "visible",
  appearanceTheme: "",
  snippets: [],
  accentColor: "",
  fontText: "",
  fontMono: "",
  textSize: defaultTextSize(
    detectPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent),
  ),
  treeSort: "name-asc",
  treeGitStatus: true,
  shortcuts: {},
  captureShortcut: "",
  captureTarget: "daily",
  captureInbox: "",
  captureTemplate: "",
  terminalEnabled: false,
  terminalConfirmed: false,
  terminalVisible: false,
  terminalHeight: DEFAULT_TERMINAL_HEIGHT,
};

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;
const text = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;
const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Settings from any parsed JSON: every key that is missing or has the wrong type gets its default. */
export function sanitizeSettings(raw: unknown): StoredSettings {
  const o: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const d = DEFAULT_SETTINGS;
  return {
    theme:
      o["theme"] === "light" || o["theme"] === "dark" || o["theme"] === "system"
        ? o["theme"]
        : d.theme,
    math: bool(o["math"], d.math),
    sidebar: bool(o["sidebar"], d.sidebar),
    sidebarWidth: finite(o["sidebarWidth"], d.sidebarWidth),
    activeView: text(o["activeView"], d.activeView),
    backlinks: bool(o["backlinks"], d.backlinks),
    outline: o["outline"] === true,
    panelWidth: sanitizePanelWidth(o["panelWidth"]),
    linkPreview: sanitizeMode(o["linkPreview"]),
    lastFolder: typeof o["lastFolder"] === "string" ? o["lastFolder"] : null,
    recentVaults: sanitizeRecent(o["recentVaults"]),
    vaultStates: sanitizeStates(o["vaultStates"]),
    zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, finite(o["zoom"], d.zoom))),
    healthExclude: Array.isArray(o["healthExclude"])
      ? o["healthExclude"].filter((v): v is string => typeof v === "string")
      : [],
    templateFolder: text(o["templateFolder"], d.templateFolder),
    dailyFolder: text(o["dailyFolder"], d.dailyFolder),
    dailyFormat: text(o["dailyFormat"], d.dailyFormat),
    dailyTemplate: text(o["dailyTemplate"], d.dailyTemplate),
    gitAuthorName: text(o["gitAuthorName"], d.gitAuthorName),
    gitAuthorEmail: text(o["gitAuthorEmail"], d.gitAuthorEmail),
    gitEnterpriseHost: text(o["gitEnterpriseHost"], d.gitEnterpriseHost),
    autoSync: o["autoSync"] === true,
    autoSyncMinutes: clampMinutes(Number(o["autoSyncMinutes"] ?? d.autoSyncMinutes)),
    autoSyncOnFocus: o["autoSyncOnFocus"] === true,
    autoSyncOnQuit: o["autoSyncOnQuit"] === true,
    reviewBranchPrefix: text(o["reviewBranchPrefix"], d.reviewBranchPrefix),
    bookmarksInVault: o["bookmarksInVault"] === true,
    extractEmbed: o["extractEmbed"] === true,
    wrapCode: o["wrapCode"] === true,
    sourceMode: o["sourceMode"] === true,
    exportPageBreaks: bool(o["exportPageBreaks"], d.exportPageBreaks),
    exportDark: o["exportDark"] === true,
    exportPageSize: sanitizePageSize(o["exportPageSize"]),
    propertiesDisplay: sanitizePropertiesDisplay(o["propertiesDisplay"]),
    appearanceTheme: text(o["appearanceTheme"], d.appearanceTheme),
    snippets: sanitizeNames(o["snippets"]),
    accentColor: sanitizeAccent(o["accentColor"]),
    fontText: sanitizeFont(o["fontText"]),
    fontMono: sanitizeFont(o["fontMono"]),
    textSize: sanitizeTextSize(o["textSize"], d.textSize),
    treeSort: sanitizeTreeSort(o["treeSort"]),
    treeGitStatus: o["treeGitStatus"] !== false,
    shortcuts: sanitizeShortcuts(o["shortcuts"]),
    captureShortcut: text(o["captureShortcut"], d.captureShortcut).trim(),
    captureTarget: o["captureTarget"] === "inbox" ? "inbox" : "daily",
    captureInbox: text(o["captureInbox"], d.captureInbox),
    captureTemplate: text(o["captureTemplate"], d.captureTemplate),
    terminalEnabled: o["terminalEnabled"] === true,
    terminalConfirmed: o["terminalConfirmed"] === true,
    terminalVisible: o["terminalVisible"] === true,
    terminalHeight: sanitizeTerminalHeight(o["terminalHeight"]),
  };
}

/** Parses JSON text; null when it is missing or not valid JSON. */
function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface LoadedSettings {
  settings: StoredSettings;
  /** Where they came from: the file, the old `localStorage` entry (to be migrated) or nothing (defaults). */
  source: "file" | "legacy" | "defaults";
  /** The file exists but is no JSON object; it must not be overwritten. */
  damaged: boolean;
}

/**
 * The settings to start with. The settings file wins; without one (first start after the update)
 * the old `localStorage` entry is migrated; without that the defaults apply. A file that is no
 * JSON object does not stop the app from starting, but is flagged `damaged` and left untouched.
 */
export function loadSettings(file: string | null, legacy: string | null): LoadedSettings {
  const isObject = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  const fromFile = parseJson(file);
  if (isObject(fromFile))
    return { settings: sanitizeSettings(fromFile), source: "file", damaged: false };
  const damaged = file !== null;
  const fromLegacy = parseJson(legacy);
  if (isObject(fromLegacy))
    return { settings: sanitizeSettings(fromLegacy), source: "legacy", damaged };
  return { settings: sanitizeSettings(null), source: "defaults", damaged };
}

export function serializeSettings(settings: StoredSettings): string {
  return JSON.stringify(settings, null, 2);
}
