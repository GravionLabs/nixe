import { Injectable, signal } from "@angular/core";

/** The groups of the palette in their fixed order. */
export const COMMAND_GROUPS = [
  "File",
  "Edit",
  "View",
  "Navigate",
  "Git",
  "Export",
  "Vault",
  "Other",
] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export interface Command {
  /** Unique id; the native menu emits it, plugins register their own. */
  id: string;
  title: string;
  /** The palette lists the command under this heading. */
  group: CommandGroup;
  /** Display shortcut like `Mod+Shift+F` (`Mod` is ⌘ on macOS, Ctrl elsewhere). */
  shortcut?: string;
  /** Extra key bindings the webview handles itself (the native menu covers the others). */
  keys?: readonly string[];
  /** The command is available only while this returns true. Absent means always. */
  when?: () => boolean;
  run: () => unknown;
}

/** The parts of a keyboard event a binding is matched against. */
export interface KeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** The physical key (`KeyA`); lets ⌥ letters match on macOS, where `key` is a different character. */
  code?: string;
}

const PUNCTUATION: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

/** The lower-case key name of a physical key code (`KeyA` → `a`, `Comma` → `,`); null for others. */
export function physicalKey(code: string | undefined): string | null {
  if (!code) return null;
  const m = /^Key([A-Z])$/.exec(code) ?? /^Digit(\d)$/.exec(code);
  return m ? m[1].toLowerCase() : (PUNCTUATION[code] ?? null);
}

/** True when `event` is the key combination `binding` (`Mod+Shift+F`, `Alt+ArrowLeft`). */
export function matchesBinding(event: KeyInput, binding: string): boolean {
  const parts = binding.split("+");
  const key = parts.pop()!.toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const named = key === "plus" ? "+" : key === "space" ? " " : key;
  // The physical key counts only where the character is no letter or digit (⌥ and ⇧ change it).
  const physical = !/^[a-z0-9]$/i.test(event.key) && physicalKey(event.code) === key;
  return (
    (event.key.toLowerCase() === named || physical) &&
    (mods.has("ctrl")
      ? event.ctrlKey && !event.metaKey
      : (event.metaKey || event.ctrlKey) === mods.has("mod")) &&
    event.shiftKey === mods.has("shift") &&
    event.altKey === mods.has("alt")
  );
}

const MAC_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  ctrl: "⌃",
  shift: "⇧",
  alt: "⌥",
  arrowleft: "←",
  arrowright: "→",
  plus: "+",
};
const OTHER_NAMES: Record<string, string> = {
  mod: "Ctrl",
  arrowleft: "←",
  arrowright: "→",
  plus: "+",
};

/** A shortcut as shown to the user: `⌘⇧F` on macOS, `Ctrl+Shift+F` elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string {
  const parts = shortcutKeys(shortcut, mac);
  return mac ? parts.join("") : parts.join("+");
}

/** The key caps of a shortcut for `hx-kbd`: `["⌘", "⇧", "F"]` on macOS, `["Ctrl", "Shift", "F"]` elsewhere. */
export function shortcutKeys(shortcut: string, mac: boolean): string[] {
  if (!shortcut) return [];
  return shortcut.split("+").map((p) => (mac ? MAC_SYMBOLS : OTHER_NAMES)[p.toLowerCase()] ?? p);
}

/** Every action of the app by id: menu, shortcuts and the palette all run commands from here. */
@Injectable({ providedIn: "root" })
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();
  private readonly version = signal(0);
  /** The user's shortcuts by command id ("" is removed); set by the `ShortcutService`. */
  readonly overrides = signal<Readonly<Record<string, string>>>({});

  /** Registers a command, replacing one with the same id. Returns a function that removes it. */
  register(command: Command): () => void {
    this.commands.set(command.id, command);
    this.version.update((v) => v + 1);
    return () => {
      if (this.commands.get(command.id) !== command) return;
      this.commands.delete(command.id);
      this.version.update((v) => v + 1);
    };
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
    this.version();
    return [...this.commands.values()];
  }

  /** The commands whose `when` condition holds now. */
  available(): Command[] {
    return this.all().filter((c) => isAvailable(c));
  }

  /** Runs a command; false when it is unknown or its `when` condition does not hold. */
  execute(id: string): boolean {
    const command = this.commands.get(id);
    if (!command || !isAvailable(command)) return false;
    void command.run();
    return true;
  }

  /** The shortcut of a command as shown: the user's own, else the default; "" when none. */
  shortcutOf(command: Command): string {
    return this.overrides()[command.id] ?? command.shortcut ?? "";
  }

  /** The key bindings the webview handles for a command: the user's shortcut replaces the defaults. */
  keysOf(command: Command): readonly string[] {
    const own = this.overrides()[command.id];
    if (own === undefined) return command.keys ?? [];
    return own ? [own] : [];
  }

  /** The command bound to a key press in the webview, if any. */
  findByKey(event: KeyInput): Command | undefined {
    return this.all().find((c) => this.keysOf(c).some((k) => matchesBinding(event, k)));
  }
}

function isAvailable(command: Command): boolean {
  return command.when?.() ?? true;
}
