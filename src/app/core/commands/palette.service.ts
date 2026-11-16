import { Injectable, computed, inject, signal } from "@angular/core";

import { fuzzyScore } from "../switcher/fuzzy";
import { Command, CommandRegistry } from "./command-registry";

/** Command palette state: the query and the available commands ranked by fuzzy title match. */
@Injectable({ providedIn: "root" })
export class PaletteService {
  private readonly registry = inject(CommandRegistry);

  readonly visible = signal(false);
  readonly query = signal("");
  readonly selected = signal(0);
  /** Bumped on open so that `when` conditions are evaluated again. */
  private readonly opened = signal(0);

  readonly matches = computed<Command[]>(() => {
    this.opened();
    const q = this.query().trim();
    const commands = this.registry.available();
    if (!q) return commands.sort((a, b) => a.title.localeCompare(b.title));
    return commands
      .map((command) => ({ command, score: fuzzyScore(q, command.title) }))
      .filter((m): m is { command: Command; score: number } => m.score !== null)
      .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title))
      .map((m) => m.command);
  });

  open(): void {
    this.query.set("");
    this.selected.set(0);
    this.opened.update((n) => n + 1);
    this.visible.set(true);
  }

  close(): void {
    this.visible.set(false);
  }

  setQuery(query: string): void {
    this.query.set(query);
    this.selected.set(0);
  }

  /** Moves the selection, wrapping around. */
  move(delta: number): void {
    const n = this.matches().length;
    if (n) this.selected.update((i) => (i + delta + n) % n);
  }

  current(): Command | null {
    return this.matches()[this.selected()] ?? null;
  }

  /** Closes the palette and runs the command. */
  run(command: Command): void {
    this.close();
    this.registry.execute(command.id);
  }
}
