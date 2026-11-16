import { Component, ElementRef, effect, inject, viewChild } from "@angular/core";

import { SettingItem } from "../../core/settings/settings-registry";
import { SettingsPageService } from "../../core/settings/settings-page.service";

/** The settings page: sections on the left, the settings of the section (or the search matches) on the right. */
@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
  host: { "(document:keydown.escape)": "page.close()" },
})
export class SettingsComponent {
  protected readonly page = inject(SettingsPageService);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("search");

  constructor() {
    effect(() => this.input()?.nativeElement.focus());
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected setNumber(item: Extract<SettingItem, { kind: "number" }>, event: Event): void {
    const value = Number(this.value(event));
    if (Number.isFinite(value)) item.set(value);
  }
}
