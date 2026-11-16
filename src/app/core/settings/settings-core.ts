import { clampMinutes } from "../git/auto-sync";
import { LinkPreviewMode, sanitizeMode } from "../preview/preview-core";
import { VaultStates, sanitizeRecent, sanitizeStates } from "../workspace/recent-vaults";

export type ThemeMode = "system" | "light" | "dark";

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
  backlinks: boolean;
  outline: boolean;
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
  autoSync: boolean;
  autoSyncMinutes: number;
  autoSyncOnFocus: boolean;
  autoSyncOnQuit: boolean;
}

export const DEFAULT_SETTINGS: StoredSettings = {
  theme: "system",
  math: true,
  sidebar: true,
  sidebarWidth: 260,
  backlinks: false,
  outline: false,
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
  autoSync: false,
  autoSyncMinutes: 10,
  autoSyncOnFocus: false,
  autoSyncOnQuit: false,
};

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const text = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** Settings from any parsed JSON: every key that is missing or has the wrong type gets its default. */
export function sanitizeSettings(raw: unknown): StoredSettings {
  const o: Record<string, unknown> = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_SETTINGS;
  return {
    theme: o["theme"] === "light" || o["theme"] === "dark" || o["theme"] === "system" ? o["theme"] : d.theme,
    math: bool(o["math"], d.math),
    sidebar: bool(o["sidebar"], d.sidebar),
    sidebarWidth: finite(o["sidebarWidth"], d.sidebarWidth),
    backlinks: bool(o["backlinks"], d.backlinks),
    outline: o["outline"] === true,
    linkPreview: sanitizeMode(o["linkPreview"]),
    lastFolder: typeof o["lastFolder"] === "string" ? o["lastFolder"] : null,
    recentVaults: sanitizeRecent(o["recentVaults"]),
    vaultStates: sanitizeStates(o["vaultStates"]),
    zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, finite(o["zoom"], d.zoom))),
    healthExclude: Array.isArray(o["healthExclude"]) ? o["healthExclude"].filter((v): v is string => typeof v === "string") : [],
    templateFolder: text(o["templateFolder"], d.templateFolder),
    dailyFolder: text(o["dailyFolder"], d.dailyFolder),
    dailyFormat: text(o["dailyFormat"], d.dailyFormat),
    dailyTemplate: text(o["dailyTemplate"], d.dailyTemplate),
    gitAuthorName: text(o["gitAuthorName"], d.gitAuthorName),
    gitAuthorEmail: text(o["gitAuthorEmail"], d.gitAuthorEmail),
    autoSync: o["autoSync"] === true,
    autoSyncMinutes: clampMinutes(Number(o["autoSyncMinutes"] ?? d.autoSyncMinutes)),
    autoSyncOnFocus: o["autoSyncOnFocus"] === true,
    autoSyncOnQuit: o["autoSyncOnQuit"] === true,
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
  if (isObject(fromFile)) return { settings: sanitizeSettings(fromFile), source: "file", damaged: false };
  const damaged = file !== null;
  const fromLegacy = parseJson(legacy);
  if (isObject(fromLegacy)) return { settings: sanitizeSettings(fromLegacy), source: "legacy", damaged };
  return { settings: sanitizeSettings(null), source: "defaults", damaged };
}

export function serializeSettings(settings: StoredSettings): string {
  return JSON.stringify(settings, null, 2);
}
