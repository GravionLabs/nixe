import type { HelixView } from "@gravionlabs/helix-desktop";

/**
 * One entry of the activity bar. The registry is declared once so that the desktop shell and the iOS
 * shell (#54) render the same list: `placement` says whether a view fills the sidebar or opens as a tab.
 * A view of the sidebar is a toggle; an entry with a `command` runs that command (a tab view or an action).
 */
export interface NixeView extends HelixView {
  /** The command a tab view or an action runs; absent for a view of the sidebar. */
  readonly command?: string;
  /** An action is a plain button; it never becomes the active view. */
  readonly kind: "view" | "action";
  /** The command whose shortcut the tooltip shows; defaults to `command`. */
  readonly shortcutCommand?: string;
  /** The view needs an open vault. */
  readonly needsVault?: boolean;
  /** The view needs a vault under Git. */
  readonly needsGit?: boolean;
}

/** The view the sidebar falls back to. */
export const DEFAULT_VIEW = "files";

export const VIEWS: readonly NixeView[] = [
  {
    id: "files",
    shortcutCommand: "toggle-sidebar",
    label: "Files",
    icon: "files",
    placement: "sidebar",
    position: "top",
    kind: "view",
  },
  {
    id: "search",
    shortcutCommand: "search",
    label: "Search",
    icon: "search",
    placement: "sidebar",
    position: "top",
    kind: "view",
    needsVault: true,
  },
  {
    id: "bookmarks",
    shortcutCommand: "show-bookmarks",
    label: "Bookmarks",
    icon: "bookmark",
    placement: "sidebar",
    position: "top",
    kind: "view",
    needsVault: true,
  },
  {
    id: "links",
    label: "Links",
    icon: "link",
    placement: "tab",
    position: "top",
    kind: "view",
    command: "show-links",
    needsVault: true,
  },
  {
    id: "git",
    shortcutCommand: "git-changes",
    label: "Git",
    icon: "git",
    placement: "sidebar",
    position: "top",
    kind: "view",
    needsVault: true,
    needsGit: true,
  },
  {
    id: "history",
    shortcutCommand: "note-history",
    label: "Note history",
    icon: "history",
    placement: "sidebar",
    position: "top",
    kind: "view",
    needsVault: true,
    needsGit: true,
  },
  {
    id: "daily-note",
    label: "Daily note",
    icon: "calendar",
    placement: "tab",
    position: "bottom",
    kind: "action",
    command: "daily-note",
    needsVault: true,
  },
  {
    id: "health",
    label: "Vault health",
    icon: "health",
    placement: "tab",
    position: "bottom",
    kind: "action",
    command: "vault-health",
    needsVault: true,
  },
  {
    id: "settings",
    label: "Settings",
    icon: "settings",
    placement: "tab",
    position: "bottom",
    kind: "action",
    command: "open-settings",
  },
];

/** What decides which views are offered. */
export interface ViewContext {
  vault: boolean;
  git: boolean;
}

export function findView(id: string): NixeView | undefined {
  return VIEWS.find((v) => v.id === id);
}

/** True for a view that fills the sidebar. */
export function isSidebarView(id: string): boolean {
  const view = findView(id);
  return view?.placement === "sidebar" && view.kind === "view";
}

/** The views and actions that are available now. */
export function availableViews(ctx: ViewContext): NixeView[] {
  return VIEWS.filter((v) => (!v.needsVault || ctx.vault) && (!v.needsGit || ctx.git));
}

/** The view the sidebar shows: the wanted one when it exists and is available, else the files. */
export function resolveView(id: string, ctx: ViewContext): string {
  return availableViews(ctx).some((v) => v.id === id && isSidebarView(v.id)) ? id : DEFAULT_VIEW;
}
