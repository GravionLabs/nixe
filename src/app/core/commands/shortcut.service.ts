import { Injectable, computed, effect, inject, signal } from "@angular/core";

import { backend } from "../file/backend";
import { SettingsService } from "../settings/settings.service";
import { Command, CommandRegistry, formatShortcut } from "./command-registry";
import {
  Bindings,
  RecordedKey,
  bindingFromEvent,
  canonicalBinding,
  effectiveBindings,
  findConflicts,
  platformOf,
  toAccelerator,
} from "./shortcuts-core";

/**
 * The shortcuts the user chose: kept in the settings file, applied to the key handling of the
 * webview (`CommandRegistry.overrides`) and shown in the native menu.
 */
@Injectable({ providedIn: "root" })
export class ShortcutService {
  private readonly registry = inject(CommandRegistry);
  private readonly settings = inject(SettingsService);

  readonly platform = platformOf(navigator.userAgent);
  /** The command whose shortcut waits for a key press. */
  readonly recordingId = signal<string | null>(null);
  /** True while a shortcut is being recorded: the menu accelerators are off, so keys reach the page. */
  readonly recording = computed(() => this.recordingId() !== null);
  /** A recorded shortcut that is not saved yet, with the commands that use it already. */
  readonly pending = signal<{ id: string; binding: string; conflicts: string[] } | null>(null);

  /** The shortcut of every command: the user's own or the default; "" for none. */
  readonly bindings = computed<Bindings>(() =>
    effectiveBindings(this.defaults(), this.settings.shortcuts()),
  );

  /** Menu item ids whose accelerator was set from here, so a reset or the end of recording restores them. */
  private readonly touched = new Set<string>();
  private pushing: Promise<unknown> = Promise.resolve();

  constructor() {
    effect(() => this.registry.overrides.set(this.settings.shortcuts()));
    effect(() => this.pushToMenu(this.bindings(), this.recording()));
  }

  private defaults(): Bindings {
    return Object.fromEntries(this.registry.all().map((c) => [c.id, c.shortcut ?? ""]));
  }

  defaultOf(command: Command): string {
    return command.shortcut ?? "";
  }

  isDefault(command: Command): boolean {
    return !(command.id in this.settings.shortcuts());
  }

  /** The other commands that already use `binding`. */
  conflicts(command: Command, binding: string): Command[] {
    const ids = new Set(findConflicts(this.bindings(), command.id, binding, this.platform));
    return this.registry.all().filter((c) => ids.has(c.id));
  }

  /**
   * Binds `binding` to the command ("" removes the shortcut). Commands that had the same binding
   * lose it. A binding equal to the default is stored as no override.
   */
  assign(command: Command, binding: string): void {
    const next = { ...this.settings.shortcuts() };
    for (const other of binding ? this.conflicts(command, binding) : []) next[other.id] = "";
    next[command.id] = binding;
    this.settings.shortcuts.set(this.withoutDefaults(next));
  }

  private conflictsWith(
    overrides: Record<string, string>,
    command: Command,
    binding: string,
  ): string[] {
    const defaults = Object.fromEntries(this.registry.all().map((c) => [c.id, c.shortcut ?? ""]));
    return findConflicts(
      effectiveBindings(defaults, overrides),
      command.id,
      binding,
      this.platform,
    );
  }

  /** Back to the default shortcut. */
  reset(command: Command): void {
    const next = { ...this.settings.shortcuts() };
    delete next[command.id];
    // Another command may hold the default by now; it gives it back to this one.
    for (const other of this.conflictsWith(next, command, this.defaultOf(command)))
      next[other] = "";
    this.settings.shortcuts.set(this.withoutDefaults(next));
  }

  /** Waits for the key press that becomes the shortcut of the command. */
  startRecording(id: string): void {
    this.pending.set(null);
    this.recordingId.set(id);
  }

  /** Stops recording and drops an unsaved shortcut. */
  cancel(): void {
    this.recordingId.set(null);
    this.pending.set(null);
  }

  /**
   * Feeds a key press to the recorder. Escape cancels; a usable combination becomes `pending`
   * (with its conflicts, shown before anything is saved); other keys are ignored.
   */
  capture(event: RecordedKey): void {
    const id = this.recordingId();
    const command = id === null ? undefined : this.registry.get(id);
    if (!command) return this.cancel();
    if (
      event.key === "Escape" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    )
      return this.cancel();
    const binding = bindingFromEvent(event, this.platform);
    if (binding === null) return;
    this.recordingId.set(null);
    this.pending.set({
      id: command.id,
      binding,
      conflicts: this.conflicts(command, binding).map((c) => c.title),
    });
  }

  /** Saves the pending shortcut; the commands that used it lose it. */
  savePending(): void {
    const pending = this.pending();
    const command = pending && this.registry.get(pending.id);
    this.pending.set(null);
    if (command && pending) this.assign(command, pending.binding);
  }

  /** The shortcut of a command as shown to the user; "" when it has none. */
  display(id: string): string {
    const binding = this.bindings()[id];
    return binding ? formatShortcut(binding, this.platform === "mac") : "";
  }

  formatBinding(binding: string): string {
    return formatShortcut(binding, this.platform === "mac");
  }

  /** Drops the entries that say what the default already says. */
  private withoutDefaults(overrides: Record<string, string>): Record<string, string> {
    const same = (a: string, b: string) =>
      canonicalBinding(a, this.platform) === canonicalBinding(b, this.platform);
    const result: Record<string, string> = {};
    for (const [id, binding] of Object.entries(overrides)) {
      const command = this.registry.get(id);
      if (command && same(binding, this.defaultOf(command))) continue;
      result[id] = binding;
    }
    return result;
  }

  private pushToMenu(bindings: Bindings, recording: boolean): void {
    const own = this.settings.shortcuts();
    const payload: Record<string, string | null> = {};
    for (const id of Object.keys(bindings)) {
      if (recording) {
        payload[id] = null;
        this.touched.add(id);
      } else if (id in own || this.touched.has(id)) {
        payload[id] = bindings[id] ? toAccelerator(bindings[id]) : null;
        this.touched.add(id);
      }
    }
    if (Object.keys(payload).length === 0) return;
    this.pushing = this.pushing
      .then(() => backend.setMenuShortcuts(payload))
      .catch((err) => console.warn("menu shortcuts not updated", err));
  }
}
