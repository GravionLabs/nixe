import { NgTemplateOutlet } from "@angular/common";
import type { OnDestroy } from "@angular/core";
import { Component, ElementRef, effect, inject, signal, viewChild } from "@angular/core";
import { HxButton, HxField, HxFieldset, HxInput, HxSelect, HxSwitch } from "@gravionlabs/helix-ui";

import { CommandRegistry } from "../../core/commands/command-registry";
import { ShortcutService } from "../../core/commands/shortcut.service";
import type { SettingItem } from "../../core/settings/settings-registry";
import { SettingsPageService } from "../../core/settings/settings-page.service";

/** The settings page: sections on the left, the settings of the section (or the search matches) on the right. */
@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
  imports: [HxButton, HxField, HxFieldset, HxInput, HxSelect, HxSwitch, NgTemplateOutlet],
})
export class SettingsComponent implements OnDestroy {
  protected readonly page = inject(SettingsPageService);
  protected readonly shortcuts = inject(ShortcutService);
  protected readonly commands = inject(CommandRegistry);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>("search");

  // The button is a Helix component: read its element, not the component instance.
  private readonly recorder = viewChild("recorder", {
    read: ElementRef<HTMLButtonElement>,
  });

  constructor() {
    // A restored tab (or another vault) has no Obsidian settings loaded yet.
    void this.page.refreshObsidian();
    void this.page.loadLocations();
    effect(() => this.input()?.nativeElement.focus());
    effect(() => this.recorder()?.nativeElement.focus());
  }

  ngOnDestroy(): void {
    this.shortcuts.cancel();
  }

  /** While recording, the button swallows every key so no command runs. */
  protected onShortcutKey(event: KeyboardEvent): void {
    if (!this.shortcuts.recording()) return;
    event.preventDefault();
    event.stopPropagation();
    this.shortcuts.capture(event);
  }

  protected readonly tokenError = signal("");
  /** The token field is hidden until the user picks Replace or the manual fallback. */
  protected readonly tokenEditing = signal(false);

  protected showTokenInput(item: Extract<SettingItem, { kind: "token" }>): boolean {
    return (
      this.tokenEditing() || item.prompt() !== null || (!item.stored() && !item.gh?.available())
    );
  }

  protected async saveToken(
    item: Extract<SettingItem, { kind: "token" }>,
    input: HTMLInputElement,
  ): Promise<void> {
    try {
      await item.save(input.value);
      input.value = "";
      this.tokenError.set("");
      this.tokenEditing.set(false);
    } catch (err) {
      this.tokenError.set(String(err));
    }
  }

  protected async deleteToken(item: Extract<SettingItem, { kind: "token" }>): Promise<void> {
    try {
      await item.remove();
      this.tokenError.set("");
    } catch (err) {
      this.tokenError.set(String(err));
    }
  }

  protected readonly locName = signal("");
  protected readonly locPath = signal("");
  /** The name of the row being edited; null while a new variable is typed. */
  protected readonly locPrevious = signal<string | null>(null);
  protected readonly locError = signal("");

  protected editLocation(v: { name: string; path: string }): void {
    this.locName.set(v.name);
    this.locPath.set(v.path);
    this.locPrevious.set(v.name);
    this.locError.set("");
  }

  protected cancelLocation(): void {
    this.locName.set("");
    this.locPath.set("");
    this.locPrevious.set(null);
    this.locError.set("");
  }

  protected async saveLocation(item: Extract<SettingItem, { kind: "locations" }>): Promise<void> {
    try {
      await item.save(this.locName(), this.locPath(), this.locPrevious());
      this.cancelLocation();
    } catch (err) {
      this.locError.set(String(err));
    }
  }

  protected async removeLocation(
    item: Extract<SettingItem, { kind: "locations" }>,
    name: string,
  ): Promise<void> {
    try {
      await item.remove(name);
      if (this.locPrevious() === name) this.cancelLocation();
      else this.locError.set("");
    } catch (err) {
      this.locError.set(String(err));
    }
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected setSelect(item: Extract<SettingItem, { kind: "select" }>, value: unknown): void {
    if (typeof value === "string") item.set(value);
  }

  protected setNumber(item: Extract<SettingItem, { kind: "number" }>, event: Event): void {
    const value = Number(this.value(event));
    if (Number.isFinite(value)) item.set(value);
  }
}
