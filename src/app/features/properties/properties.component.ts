import { NgTemplateOutlet } from "@angular/common";
import { Component, computed, inject, output, signal } from "@angular/core";

import { backend } from "../../core/file/backend";
import { SettingsService } from "../../core/settings/settings.service";
import { DocumentService } from "../../core/file/document.service";
import { editFrontmatter, type PropertyEdit } from "../../core/markdown/frontmatter-edit";
import { splitFrontmatter } from "../../core/markdown/frontmatter";
import { toProperties, type Property, type PropertyType } from "../../core/markdown/properties";
import {
  NEW_PROPERTY_TYPES,
  chipSuggestions,
  chipText,
  initialValue,
  propertiesSummary,
  isDateOnly,
  listItems,
  parseNumber,
} from "../../core/markdown/properties-edit";

const today = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The properties of the open note, edited in place; every change is written into the frontmatter. */
@Component({
  selector: "app-properties",
  templateUrl: "./properties.component.html",
  styleUrl: "./properties.component.css",
  imports: [NgTemplateOutlet],
})
export class PropertiesComponent {
  readonly failed = output<string>();

  private readonly doc = inject(DocumentService);
  private readonly settings = inject(SettingsService);

  protected readonly display = this.settings.propertiesDisplay;
  protected readonly summary = computed(() => propertiesSummary(this.props()));
  protected readonly toggle = (): void => this.settings.toggleProperties();

  protected readonly types = NEW_PROPERTY_TYPES;
  protected readonly adding = signal(false);
  protected readonly parsed = computed(() => splitFrontmatter(this.doc.content()));
  protected readonly props = computed(() => toProperties(this.parsed().data));
  private readonly tagIndex = signal<string[]>([]);
  private readonly aliasIndex = signal<string[]>([]);

  protected readonly isDateOnly = isDateOnly;
  protected readonly items = listItems;
  protected readonly isObject = (v: unknown): boolean =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  protected readonly json = (v: unknown): string => JSON.stringify(v);

  /** The index values to complete from: vault tags for `tags`, the aliases of the notes for `aliases`. */
  protected suggestionsFor(key: string): string[] {
    return /^tags?$/i.test(key) ? this.tagIndex() : this.aliasIndex();
  }

  protected suggest(source: readonly string[], p: Property): string[] {
    return chipSuggestions(source, "", listItems(p.value));
  }

  protected async loadSuggestions(): Promise<void> {
    const [tags, notes] = await Promise.all([
      backend.tags().catch(() => []),
      backend.notes().catch(() => []),
    ]);
    this.tagIndex.set(tags.map((t) => t.tag));
    this.aliasIndex.set([...new Set(notes.flatMap((n) => n.aliases))].sort());
  }

  protected set(key: string, value: unknown): Promise<boolean> {
    return this.apply({ kind: "set", key, value });
  }

  protected setNumber(key: string, input: HTMLInputElement): Promise<boolean> {
    const n = parseNumber(input.value);
    if (n === null) {
      const old = this.props().find((p) => p.key === key)?.value;
      input.value = typeof old === "number" || typeof old === "string" ? String(old) : "";
      return Promise.resolve(false);
    }
    return this.set(key, n);
  }

  protected async rename(from: string, input: HTMLInputElement): Promise<void> {
    const to = input.value.trim();
    if (!to || to === from) {
      input.value = from;
      return;
    }
    if (!(await this.apply({ kind: "rename", from, to }))) input.value = from;
  }

  protected remove(key: string): Promise<boolean> {
    return this.apply({ kind: "remove", key });
  }

  protected addChip(p: Property, input: HTMLInputElement): Promise<boolean> | void {
    const text = chipText(p.key, input.value);
    input.value = "";
    const items = listItems(p.value);
    if (!text || items.some((i) => i.toLowerCase() === text.toLowerCase())) return;
    return this.apply({ kind: "set", key: p.key, value: [...items, text] });
  }

  protected removeChip(p: Property, index: number): Promise<boolean> {
    return this.apply({
      kind: "set",
      key: p.key,
      value: listItems(p.value).filter((_, i) => i !== index),
    });
  }

  protected onChipKey(event: KeyboardEvent, p: Property): void {
    const input = event.target as HTMLInputElement;
    if (event.key === "," || (event.key === "Enter" && input.value.trim())) {
      event.preventDefault();
      void this.addChip(p, input);
    } else if (event.key === "Backspace" && !input.value) {
      const items = listItems(p.value);
      if (items.length) void this.removeChip(p, items.length - 1);
    }
  }

  protected async add(name: HTMLInputElement, kind: HTMLSelectElement): Promise<void> {
    const key = name.value.trim();
    if (!key) return;
    if (this.props().some((p) => p.key === key)) {
      this.failed.emit(`The property "${key}" already exists.`);
      return;
    }
    const value = initialValue(kind.value as PropertyType, today());
    if (await this.apply({ kind: "set", key, value })) this.adding.set(false);
  }

  /** Writes the change into the note; false (and an error) when the note could not be changed. */
  private async apply(edit: PropertyEdit): Promise<boolean> {
    const path = this.doc.path();
    if (!path) return false;
    const text = this.doc.content();
    try {
      const next = editFrontmatter(text, edit);
      if (next !== text) await this.doc.write(path, next);
      return true;
    } catch (err) {
      this.failed.emit(err instanceof Error ? err.message : String(err));
      return false;
    }
  }
}
