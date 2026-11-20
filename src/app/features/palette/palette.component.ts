import type { ElementRef } from "@angular/core";
import { Component, effect, inject, output, viewChild } from "@angular/core";
import { HxDialog, HxKbd } from "@gravionlabs/helix-ui";

import type { KeyHint } from "./key-hints.component";
import { KeyHintsComponent, isMac, modKey } from "./key-hints.component";
import { PREFIX_HINTS } from "../../core/commands/palette.service";
import type { PaletteItem, PaletteMode } from "../../core/commands/palette.service";
import { PaletteService } from "../../core/commands/palette.service";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { basename } from "../../core/markdown/paths";
import { highlightParts } from "../../core/switcher/fuzzy";

const PLACEHOLDERS: Record<PaletteMode, string> = {
  notes: "Open note…",
  commands: "Run a command…",
  headings: "Go to heading…",
  tags: "Search a tag…",
  templates: "Insert template…",
  vaults: "Open recent vault…",
};

const EMPTY: Record<PaletteMode, string> = {
  notes: "No notes",
  commands: "No matching command",
  headings: "No matching heading",
  tags: "No matching tag",
  templates: "No matching template",
  vaults: "No recent vaults",
};

const NOUN: Record<PaletteMode, string> = {
  notes: "notes",
  commands: "commands",
  headings: "headings",
  tags: "tags",
  templates: "templates",
  vaults: "vaults",
};

/** The one overlay: notes, `>` commands, `@` headings, `#` tags and `/` templates. */
@Component({
  selector: "app-palette",
  templateUrl: "./palette.component.html",
  styleUrl: "./palette.component.css",
  imports: [HxDialog, HxKbd, KeyHintsComponent],
})
export class PaletteComponent {
  protected readonly palette = inject(PaletteService);
  protected readonly shortcuts = inject(ShortcutService);

  readonly failed = output<string>();
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("input");

  protected readonly parts = highlightParts;
  protected readonly vaultName = basename;

  constructor() {
    effect(() => this.input()?.nativeElement.focus());
  }

  protected placeholder(): string {
    return this.palette.query()
      ? PLACEHOLDERS[this.palette.mode()]
      : "Open note… (> commands, @ headings, # tags, / templates)";
  }

  protected emptyText(): string {
    return EMPTY[this.palette.mode()];
  }

  protected key(item: PaletteItem): string {
    switch (item.kind) {
      case "note":
        return `${item.match.entry.rootPath ?? ""}${item.match.entry.path}`;
      case "command":
        return item.command.id;
      case "heading":
        return `${item.heading.line}`;
      case "tag":
        return item.tag.tag;
      case "template":
        return item.entry.path;
      case "vault":
        return item.path;
    }
  }

  /** The keys of the dialog; with an empty input the prefixes lead. */
  protected hints(): KeyHint[] {
    const keys: KeyHint[] = [
      { keys: "↑↓", label: "move" },
      { keys: "Esc", label: "close" },
    ];
    if (!this.palette.query()) {
      return [...PREFIX_HINTS.map((h) => ({ keys: h.prefix, label: h.label })), ...keys];
    }
    const mode = this.palette.mode();
    if (mode === "notes") {
      const none = this.palette.items().length === 0;
      return [
        none ? { keys: "Enter", label: "to create" } : { keys: "Enter", label: "open" },
        { keys: `${modKey()}+Enter`, label: "new tab" },
        ...keys,
      ];
    }
    const label = mode === "commands" ? "run" : mode === "templates" ? "insert" : "open";
    return [{ keys: "Enter", label }, ...keys];
  }

  /** Text for the live region: the number of results, or that nothing matches. */
  protected announcement(): string {
    const n = this.palette.items().length;
    if (!n)
      return this.palette.text().trim()
        ? `No ${NOUN[this.palette.mode()]} match`
        : EMPTY[this.palette.mode()];
    return n === 1 ? "1 result" : `${n} results`;
  }

  protected onInput(event: Event): void {
    this.palette.setQuery((event.target as HTMLInputElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        this.palette.move(1);
        break;
      case "ArrowUp":
        this.palette.move(-1);
        break;
      case "Enter": {
        const item = this.palette.current();
        if (item) void this.run(item, isMac() ? event.metaKey : event.ctrlKey);
        else void this.create();
        break;
      }
      case "Escape":
        this.palette.close();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  protected async run(item: PaletteItem, newTab = false): Promise<void> {
    try {
      await this.palette.run(item, newTab);
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  protected async create(): Promise<void> {
    try {
      await this.palette.createNote();
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}
