import type { HistoryEntry } from "../file/document.service";

/** The views that open as a tab instead of a note and are restored with the layout. */
export const TAB_VIEWS = ["settings", "health"] as const;
export type StoredView = (typeof TAB_VIEWS)[number];
/** The compare, review and log views are not stored: their texts live in memory only. */
export type TabView = StoredView | "compare" | "review" | "log";

/** What a vault restores of its tabs: the panes, their tabs and the divider. */
export interface TabState {
  /** The view of a tab that is not a note; null for a note or an empty tab. */
  view: StoredView | null;
  /** The shown note; null for an empty tab or a view. */
  path: string | null;
  /** Back/forward list of the tab and the position in it. */
  history: HistoryEntry[];
  index: number;
  /** True when the tab shows the editor, false for the viewer. */
  editing: boolean;
  /** 1-based first visible line. */
  line: number | null;
  /** True for the preview tab of the pane (#416); a missing value of an older layout is pinned. */
  preview: boolean;
}

export interface PaneState {
  tabs: TabState[];
  /** Index of the shown tab. */
  active: number;
}

export interface LayoutState {
  /** One pane, or two (the second one is to the right). */
  panes: PaneState[];
  /** Index of the focused pane. */
  focused: number;
  /** Share of the width the first pane takes when there are two. */
  ratio: number;
}

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;
export const MAX_TABS = 50;
const MAX_HISTORY = 200;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(Math.max(ratio, MIN_RATIO), MAX_RATIO);
}

/** An entry of the current format, or a bare path of the older one (no position). */
function sanitizeEntry(raw: unknown): HistoryEntry | null {
  if (typeof raw === "string") return raw === "" ? null : { path: raw, line: null, anchor: null };
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e["path"] !== "string" || e["path"] === "") return null;
  const line =
    typeof e["line"] === "number" && Number.isFinite(e["line"]) && e["line"] >= 1
      ? Math.floor(e["line"])
      : null;
  const anchor = typeof e["anchor"] === "string" && e["anchor"] !== "" ? e["anchor"] : null;
  return { path: e["path"], line, anchor };
}

function sanitizeTab(raw: unknown): TabState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const view = TAB_VIEWS.find((v) => v === t["view"]) ?? null;
  if (view)
    return { view, path: null, history: [], index: -1, editing: false, line: null, preview: false };
  const path = typeof t["path"] === "string" && t["path"] !== "" ? t["path"] : null;
  const history = Array.isArray(t["history"])
    ? t["history"]
        .map(sanitizeEntry)
        .filter((e): e is HistoryEntry => e !== null)
        .slice(-MAX_HISTORY)
    : [];
  const index =
    typeof t["index"] === "number" && Number.isInteger(t["index"])
      ? t["index"]
      : history.length - 1;
  const line =
    typeof t["line"] === "number" && Number.isFinite(t["line"]) && t["line"] >= 1
      ? Math.floor(t["line"])
      : null;
  return {
    view: null,
    path,
    history,
    index: Math.min(Math.max(index, -1), history.length - 1),
    editing: path !== null && t["editing"] === true,
    line,
    preview: path !== null && t["preview"] === true,
  };
}

function clampIndex(value: unknown, length: number): number {
  const n = typeof value === "number" && Number.isInteger(value) ? value : 0;
  return Math.min(Math.max(n, 0), Math.max(length - 1, 0));
}

/** Reads a stored layout defensively; null when nothing usable is left. */
export function sanitizeLayout(value: unknown): LayoutState | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["panes"])) return null;
  const panes: PaneState[] = [];
  for (const rawPane of v["panes"].slice(0, 2)) {
    if (typeof rawPane !== "object" || rawPane === null) continue;
    const p = rawPane as Record<string, unknown>;
    const tabs = (Array.isArray(p["tabs"]) ? p["tabs"] : [])
      .slice(0, MAX_TABS)
      .map(sanitizeTab)
      .filter((t): t is TabState => t !== null);
    if (tabs.length === 0) continue;
    panes.push({ tabs, active: clampIndex(p["active"], tabs.length) });
  }
  if (panes.length === 0) return null;
  return {
    panes,
    focused: clampIndex(v["focused"], panes.length),
    ratio: clampRatio(typeof v["ratio"] === "number" ? v["ratio"] : 0.5),
  };
}

/** True when some tab of the layout shows a note or a view. */
export function layoutHasNote(layout: LayoutState): boolean {
  return layout.panes.some((p) => p.tabs.some((t) => t.path !== null || t.view !== null));
}
