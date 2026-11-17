import { LayoutState, sanitizeLayout } from "../tabs/layout";

/** How many vaults `File → Open recent` remembers. */
export const MAX_RECENT_VAULTS = 5;

/** What a vault restores when it is opened again. */
export interface VaultState {
  /** The note that was open, as an absolute path. */
  note: string | null;
  sidebar: boolean;
  backlinks: boolean;
  outline: boolean;
  /** The tabs and the split; absent in states stored before tabs existed. */
  layout?: LayoutState;
}

export type VaultStates = Record<string, VaultState>;

/** `path` first, any earlier entry of it removed, at most `max` entries. */
export function addRecent(list: readonly string[], path: string, max = MAX_RECENT_VAULTS): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}

export function removeRecent(list: readonly string[], path: string): string[] {
  return list.filter((p) => p !== path);
}

/** The states of the vaults still in `recent`; the others are dropped so the store cannot grow. */
export function pruneStates(states: VaultStates, recent: readonly string[]): VaultStates {
  return Object.fromEntries(Object.entries(states).filter(([path]) => recent.includes(path)));
}

/** Reads a stored list defensively: only strings, no duplicates, at most `max`. */
export function sanitizeRecent(value: unknown, max = MAX_RECENT_VAULTS): string[] {
  if (!Array.isArray(value)) return [];
  const paths = value.filter((p): p is string => typeof p === "string" && p !== "");
  return [...new Set(paths)].slice(0, max);
}

/** Reads stored vault states defensively; an entry with the wrong shape is dropped. */
export function sanitizeStates(value: unknown): VaultStates {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: VaultStates = {};
  for (const [path, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null) continue;
    const s = raw as Record<string, unknown>;
    out[path] = {
      note: typeof s["note"] === "string" ? s["note"] : null,
      sidebar: s["sidebar"] !== false,
      backlinks: s["backlinks"] === true,
      outline: s["outline"] === true,
    };
    const layout = sanitizeLayout(s["layout"]);
    if (layout) out[path].layout = layout;
  }
  return out;
}
