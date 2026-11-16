import { Component, ElementRef, OnDestroy, effect, inject, viewChild } from "@angular/core";

import { CommandRegistry } from "../../core/commands/command-registry";
import { ShortcutService } from "../../core/commands/shortcut.service";
import { SettingItem } from "../../core/settings/settings-registry";
import { SettingsPageService } from "../../core/settings/settings-page.service";

/** The settings page: sections on the left, the settings of the section (or the search matches) on the right. */
@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
  host: { "(document:keydown.escape)": "page.close()" },
})
export class SettingsComponent implements OnDestroy {
  protected readonly page = inject(SettingsPageService);
  protected readonly shortcuts = inject(ShortcutService);
  protected readonly commands = inject(CommandRegistry);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("search");

  private readonly recorder = viewChild<ElementRef<HTMLButtonElement>>("recorder");

  constructor() {
    effect(() => this.input()?.nativeElement.focus());
    effect(() => this.recorder()?.nativeElement.focus());
  }

  ngOnDestroy(): void {
    this.shortcuts.cancel();
  }

  /** While recording, the button swallows every key so no command runs and Escape does not close the page. */
  protected onShortcutKey(event: KeyboardEvent): void {
    if (!this.shortcuts.recording()) return;
    event.preventDefault();
    event.stopPropagation();
    this.shortcuts.capture(event);
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
