import { Component, ElementRef, effect, inject, output, viewChild } from "@angular/core";

import { TemplateEntry, TemplateService } from "../../core/templates/template.service";

/** `Insert template` overlay: type to filter, arrow keys to choose, Enter to insert. */
@Component({
  selector: "app-templates",
  templateUrl: "./templates.component.html",
  styleUrl: "../switcher/switcher.component.css",
})
export class TemplatesComponent {
  protected readonly templates = inject(TemplateService);

  readonly error = output<string>();
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("input");

  constructor() {
    effect(() => this.input()?.nativeElement.focus());
  }

  protected onInput(event: Event): void {
    this.templates.setQuery((event.target as HTMLInputElement).value);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        this.templates.move(1);
        break;
      case "ArrowUp":
        this.templates.move(-1);
        break;
      case "Enter": {
        const entry = this.templates.current();
        if (entry) void this.choose(entry);
        break;
      }
      case "Escape":
        this.templates.close();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  protected async choose(entry: TemplateEntry): Promise<void> {
    try {
      await this.templates.insert(entry);
    } catch (err) {
      this.error.emit(String(err));
    }
  }
}
