import { Component, ElementRef, effect, inject, viewChild } from "@angular/core";

import { KeyHintsComponent, KeyHint } from "../switcher/key-hints.component";
import { Command, CommandRegistry, formatShortcut } from "../../core/commands/command-registry";
import { PaletteService } from "../../core/commands/palette.service";

/** Command palette overlay: type to filter, arrow keys to choose, Enter to run. */
@Component({
  selector: "app-palette",
  templateUrl: "./palette.component.html",
  styleUrl: "./palette.component.css",
  imports: [KeyHintsComponent],
})
export class PaletteComponent {
  protected readonly palette = inject(PaletteService);
  private readonly registry = inject(CommandRegistry);
  private readonly mac = navigator.userAgent.includes("Mac");
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("input");

  constructor() {
    effect(() => this.input()?.nativeElement.focus());
  }

  protected readonly hints: KeyHint[] = [
    { keys: "Enter", label: "run" },
    { keys: "↑↓", label: "move" },
    { keys: "Esc", label: "close" },
  ];

  protected shortcut(command: Command): string {
    const shortcut = this.registry.shortcutOf(command);
    return shortcut ? formatShortcut(shortcut, this.mac) : "";
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
        const command = this.palette.current();
        if (command) this.palette.run(command);
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
}
