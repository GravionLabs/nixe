import { Injectable, inject } from "@angular/core";

import { CommandRegistry } from "../commands/command-registry";
import { DocumentService } from "../file/document.service";
import { SettingsService } from "../settings/settings.service";
import { TabsService } from "../tabs/tabs.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { ShellService } from "./shell.service";

/** The attribute on `<html>` while the focus was moved by a command: the focused region shows a ring. */
export const KEYBOARD_FOCUS_ATTRIBUTE = "data-keyboard-focus";

const NOTE_SELECTOR = ".cm-content, .markdown-body";
/** The first element that matches one of the selectors, tried in order (a selector list would take document order). */
function firstOf(...selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    const element = document.querySelector<HTMLElement>(selector);
    if (element) return element;
  }
  return null;
}

/** True for a field the user types into: Escape belongs to it (cancel a rename, clear a box). */
function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest("[role='menu']") !== null;
}

/**
 * Moves the keyboard focus between the file tree, the note and the panel. A collapsed sidebar or
 * panel opens first. Escape in the sidebar or the panel returns the focus to the note.
 */
@Injectable({ providedIn: "root" })
export class FocusService {
  private readonly commands = inject(CommandRegistry);
  private readonly shell = inject(ShellService);
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly doc = inject(DocumentService);
  private readonly tabs = inject(TabsService);

  constructor() {
    const inVault = () => this.workspace.root() !== null;
    const noteOpen = () => this.doc.path() !== null;
    this.commands.register({ id: "focus-file-tree", title: "Focus file tree", shortcut: "Mod+Shift+E", keys: ["Mod+Shift+E"], when: inVault, run: () => this.focusFileTree() });
    this.commands.register({ id: "focus-note", title: "Focus note", shortcut: "Mod+Shift+N", keys: ["Mod+Shift+N"], when: noteOpen, run: () => this.focusNote() });
    this.commands.register({ id: "focus-panel", title: "Focus panel", shortcut: "Mod+Shift+I", keys: ["Mod+Shift+I"], when: noteOpen, run: () => this.focusPanel() });
    this.commands.register({ id: "filter-file-tree", title: "Filter file tree", shortcut: "Mod+Alt+E", keys: ["Mod+Alt+E"], when: inVault, run: () => this.focusFilter() });
    document.addEventListener("pointerdown", () => document.documentElement.removeAttribute(KEYBOARD_FOCUS_ATTRIBUTE), true);
  }

  /** Shows the files, opens the sidebar when it is collapsed and focuses the row of the tree. */
  focusFileTree(): Promise<boolean> {
    this.shell.show("files");
    return this.focusWhenReady(() => firstOf("app-sidebar .row[tabindex='0']", "app-sidebar .row"));
  }

  /** Shows the files, opens the sidebar when it is collapsed and focuses the filter field above the tree. */
  focusFilter(): Promise<boolean> {
    this.shell.show("files");
    return this.focusWhenReady(() => document.querySelector<HTMLInputElement>("app-sidebar .filter"));
  }

  focusNote(): Promise<boolean> {
    return this.focusWhenReady(() => this.noteElement());
  }

  /** Opens the panel when it is collapsed (on its last tab) and focuses its active tab. */
  focusPanel(): Promise<boolean> {
    if (!this.settings.panelOpen()) this.settings.showPanelTab(this.settings.panelTab());
    return this.focusWhenReady(() => firstOf(".panel-tabs button.active", ".panel-tabs button"));
  }

  /** Escape in the sidebar or the panel: the focus goes back to the note. True when it was handled. */
  handleEscape(event: KeyboardEvent): boolean {
    if (event.key !== "Escape" || event.defaultPrevented || isTextField(event.target)) return false;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest("app-sidebar, app-search, app-bookmarks, app-history, app-git, .panel")) return false;
    if (this.doc.path() === null) return false;
    void this.focusNote();
    return true;
  }

  /** The editor or the viewer of the shown tab of the focused pane. */
  private noteElement(): HTMLElement | null {
    const sections = document.querySelectorAll<HTMLElement>("app-workspace section.pane");
    const at = this.tabs.panes().findIndex((p) => p.id === this.tabs.focusedPane().id);
    const pane = sections[at] ?? sections[0];
    return pane?.querySelector<HTMLElement>(NOTE_SELECTOR) ?? null;
  }

  /** Focuses what `find` returns; a region that was just opened renders a moment later, so it asks again a few times. */
  private focusWhenReady(find: () => HTMLElement | null): Promise<boolean> {
    return new Promise((resolve) => {
      let attempts = 0;
      const attempt = () => {
        const element = find();
        if (element) {
          document.documentElement.setAttribute(KEYBOARD_FOCUS_ATTRIBUTE, "");
          element.focus();
          resolve(true);
        } else if (++attempts > 20) resolve(false);
        else setTimeout(attempt, 25);
      };
      attempt();
    });
  }
}
