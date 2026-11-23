import { Injectable, computed, signal } from "@angular/core";

import type { OwnLocations } from "../file/backend";
import { backend } from "../file/backend";

/** The names of the built-in location variables; an own variable cannot take one (any case). */
export const BUILTIN_LOCATIONS: readonly string[] = ["Home", "Documents", "OneDrive", "iCloud"];

/**
 * The own location variables of this device (#495), such as `Books = D:\Cloud\Bücher`. The Rust
 * core stores them in the app data directory (`locations.json`), never in a workspace or the
 * vault, and checks each one: a plain name that is no built-in one, an existing absolute folder.
 */
@Injectable({ providedIn: "root" })
export class LocationsService {
  private readonly stored = signal<OwnLocations>({ variables: {} });
  private loaded = false;

  /** The variables, by name. */
  readonly variables = computed(() =>
    Object.entries(this.stored().variables)
      .map(([name, path]) => ({ name, path }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** Reads the variables of the device once; a later call changes nothing. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.stored.set(await backend.locationsList());
    } catch {
      this.loaded = false;
    }
  }

  /** Defines `name` as the folder `path`; `previous` is the name of an edited row. Rejects with the reason. */
  async save(name: string, path: string, previous: string | null = null): Promise<void> {
    this.stored.set(await backend.locationsSet(name.trim(), path.trim(), previous));
    this.loaded = true;
  }

  async remove(name: string): Promise<void> {
    this.stored.set(await backend.locationsRemove(name));
    this.loaded = true;
  }
}
