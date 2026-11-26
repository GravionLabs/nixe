import type { ElementRef } from "@angular/core";
import { Component, effect, inject, output, viewChild } from "@angular/core";
import { HxButton, HxDialog, HxField, HxInput } from "@gravionlabs/helix-ui";

import type { TargetOption } from "../../core/composer/composer.service";
import { ComposerService } from "../../core/composer/composer.service";

/** Overlay that asks for the target note of `Extract selection`, `Extract heading` and `Merge into…`. */
@Component({
  selector: "app-composer",
  templateUrl: "./composer.component.html",
  styleUrl: "../palette/palette.component.css",
  imports: [HxButton, HxDialog, HxField, HxInput],
})
export class ComposerComponent {
  protected readonly composer = inject(ComposerService);

  readonly failed = output<string>();
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("input");

  constructor() {
    effect(() => this.input()?.nativeElement.focus());
  }

  protected onInput(event: Event): void {
    this.composer.setQuery((event.target as HTMLInputElement).value);
  }

  /** The primary button of the footer: takes the selected note, as Enter in the field does. */
  protected submit(event: Event): void {
    event.preventDefault();
    const option = this.composer.current();
    if (option) void this.choose(option);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        this.composer.move(1);
        break;
      case "ArrowUp":
        this.composer.move(-1);
        break;
      case "Enter": {
        const option = this.composer.current();
        if (option) void this.choose(option);
        break;
      }
      case "Escape":
        this.composer.close();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  protected async choose(option: TargetOption): Promise<void> {
    try {
      await this.composer.choose(option);
    } catch (err) {
      this.failed.emit(String(err));
    }
  }
}
