import { Injectable } from "@angular/core";

export interface Command {
  /** Unique id; the native menu emits it, plugins register their own. */
  id: string;
  title: string;
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
}

/** True when `event` is the key combination `binding` (`Mod+Shift+F`, `Alt+ArrowLeft`). */
export function matchesBinding(event: KeyInput, binding: string): boolean {
  const parts = binding.split("+");
  const key = parts.pop()!.toLowerCase();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  return (
    event.key.toLowerCase() === key &&
    (event.metaKey || event.ctrlKey) === mods.has("mod") &&
    event.shiftKey === mods.has("shift") &&
    event.altKey === mods.has("alt")
  );
}

const MAC_SYMBOLS: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥", arrowleft: "←", arrowright: "→" };
const OTHER_NAMES: Record<string, string> = { mod: "Ctrl", arrowleft: "←", arrowright: "→" };

/** A shortcut as shown to the user: `⌘⇧F` on macOS, `Ctrl+Shift+F` elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string {
  const parts = shortcut.split("+").map((p) => (mac ? MAC_SYMBOLS : OTHER_NAMES)[p.toLowerCase()] ?? p);
  return mac ? parts.join("") : parts.join("+");
}

/** Every action of the app by id: menu, shortcuts and the palette all run commands from here. */
@Injectable({ providedIn: "root" })
export class CommandRegistry {
  private readonly commands = new Map<string, Command>();

  /** Registers a command, replacing one with the same id. Returns a function that removes it. */
  register(command: Command): () => void {
    this.commands.set(command.id, command);
    return () => {
      if (this.commands.get(command.id) === command) this.commands.delete(command.id);
    };
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  all(): Command[] {
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

  /** The command bound to a key press in the webview, if any. */
  findByKey(event: KeyInput): Command | undefined {
    return this.all().find((c) => c.keys?.some((k) => matchesBinding(event, k)));
  }
}

function isAvailable(command: Command): boolean {
  return command.when?.() ?? true;
}
