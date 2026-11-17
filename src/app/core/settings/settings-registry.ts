import { Injectable, computed, signal } from "@angular/core";

interface SettingBase {
  id: string;
  label: string;
  description?: string;
  /** Extra words the search field matches. */
  keywords?: readonly string[];
}

/** One row of the settings page. Getters are read in the template, so signals stay reactive. */
export type SettingItem = SettingBase &
  (
    | { kind: "toggle"; get: () => boolean; set: (value: boolean) => void }
    | { kind: "select"; options: readonly { value: string; label: string }[]; get: () => string; set: (value: string) => void }
    | { kind: "text"; placeholder?: string; get: () => string; set: (value: string) => void }
    | { kind: "number"; min: number; max: number; get: () => number; set: (value: number) => void }
    /** The keyboard shortcut of a command; the page records, changes, removes and resets it. */
    | { kind: "shortcut"; commandId: string }
    /** A value the app only shows: from `.obsidian/` (with its file as `source`) (or from the app). */
    | { kind: "readonly"; value: () => string; source?: () => string }
  );

/** A group of settings; features and plugins register their own. */
export interface SettingsSection {
  id: string;
  title: string;
  /** Sections are listed by this number, then by title. */
  order?: number;
  items: () => readonly SettingItem[];
}

export interface ShownSection {
  id: string;
  title: string;
  items: readonly SettingItem[];
}

/** The sections of the settings page that match `query` (every word must match). Empty query: all. */
export function filterSections(sections: readonly ShownSection[], query: string): ShownSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...sections];
  const shown: ShownSection[] = [];
  for (const section of sections) {
    const items = section.items.filter((item) => {
      const haystack = [section.title, item.label, item.description ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
      return words.every((w) => haystack.includes(w));
    });
    if (items.length) shown.push({ ...section, items });
  }
  return shown;
}

/** Every section of the settings page by id. */
@Injectable({ providedIn: "root" })
export class SettingsRegistry {
  private readonly registered = signal<readonly SettingsSection[]>([]);

  readonly sections = computed(() =>
    [...this.registered()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title)),
  );

  /** Registers a section, replacing one with the same id. Returns a function that removes it. */
  register(section: SettingsSection): () => void {
    this.registered.update((list) => [...list.filter((s) => s.id !== section.id), section]);
    return () => this.registered.update((list) => list.filter((s) => s !== section));
  }

  /** The sections with their items evaluated now. */
  shown(): ShownSection[] {
    return this.sections().map((s) => ({ id: s.id, title: s.title, items: s.items() }));
  }
}
