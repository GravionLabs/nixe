import { KeyInput, physicalKey } from "./command-registry";

export type Platform = "mac" | "windows" | "linux";

/** The platform of a user agent string. */
export function platformOf(userAgent: string): Platform {
  if (userAgent.includes("Mac")) return "mac";
  if (userAgent.includes("Windows")) return "windows";
  return "linux";
}

/** A key event as the recorder reads it; `code` is the physical key and makes ⌥ letters work on macOS. */
export interface RecordedKey extends KeyInput {
  code?: string;
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "OS", "CapsLock", "Dead"]);

/** The key name of a binding for an event: a letter or digit from the physical key, else the key itself. */
function keyName(event: RecordedKey): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  if (/^[a-z0-9]$/i.test(event.key)) return event.key.toUpperCase();
  const physical = physicalKey(event.code);
  if (event.key === " ") return "Space";
  if (event.key === "+") return "Plus";
  if (physical) return physical.toUpperCase();
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

/** Shortcuts of the native menu (copy, paste, quit, …) that no command may take. */
const RESERVED = new Set(["mod+c", "mod+x", "mod+v", "mod+a", "mod+z", "mod+q", "mod+h", "mod+m"]);

/**
 * The binding (`Mod+Shift+F`) a key press records, or null when it is no usable shortcut: only a
 * modifier, no modifier at all (except F1–F24) or a combination the menu cannot show (⌘ plus ⌃,
 * the Windows/Super key). `Mod` is ⌘ on macOS and Ctrl elsewhere; on macOS ⌃ stays `Ctrl`.
 */
export function bindingFromEvent(event: RecordedKey, platform: Platform): string | null {
  const key = keyName(event);
  if (key === null) return null;
  const mods: string[] = [];
  if (platform === "mac") {
    if (event.metaKey && event.ctrlKey) return null;
    if (event.metaKey) mods.push("Mod");
    if (event.ctrlKey) mods.push("Ctrl");
  } else {
    if (event.metaKey) return null;
    if (event.ctrlKey) mods.push("Mod");
  }
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");
  if (RESERVED.has(canonicalBinding([...mods, key].join("+"), platform))) return null;
  if (mods.length === 0 && !/^F([1-9]|1\d|2[0-4])$/.test(key)) return null;
  return [...mods, key].join("+");
}

const ORDER = ["mod", "ctrl", "alt", "shift"];

/**
 * A binding in one spelling, so two spellings of the same keys compare equal: modifiers in a fixed
 * order, case folded, and `Ctrl` is `Mod` where Ctrl is the command key (Windows, Linux).
 */
export function canonicalBinding(binding: string, platform: Platform): string {
  const parts = binding.split("+");
  const key = (parts.pop() ?? "").toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()).map((p) => (p === "ctrl" && platform !== "mac" ? "mod" : p)));
  return [...ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** The binding as a Tauri menu accelerator (`CmdOrCtrl+Shift+F`). */
export function toAccelerator(binding: string): string {
  const NAMES: Record<string, string> = { arrowleft: "Left", arrowright: "Right", arrowup: "Up", arrowdown: "Down" };
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  const mods = parts.map((p) => (p.toLowerCase() === "mod" ? "CmdOrCtrl" : p));
  return [...mods, NAMES[key.toLowerCase()] ?? key].join("+");
}

/** What the commands are bound to: the shortcut of each command id, "" for none. */
export type Bindings = Readonly<Record<string, string>>;

/** The commands (other than `id`) that already use `binding`. */
export function findConflicts(bindings: Bindings, id: string, binding: string, platform: Platform): string[] {
  if (!binding) return [];
  const wanted = canonicalBinding(binding, platform);
  return Object.entries(bindings)
    .filter(([other, b]) => other !== id && b && canonicalBinding(b, platform) === wanted)
    .map(([other]) => other);
}

/** The shortcut of every command: the user's own (`overrides`, "" is removed) or the default. */
export function effectiveBindings(defaults: Bindings, overrides: Bindings): Bindings {
  const result: Record<string, string> = {};
  for (const [id, shortcut] of Object.entries(defaults)) result[id] = id in overrides ? overrides[id] : shortcut;
  return result;
}

/** The overrides from any parsed JSON: only string values for string keys survive. */
export function sanitizeShortcuts(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string"));
}
