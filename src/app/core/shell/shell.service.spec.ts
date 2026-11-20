// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../commands/command-registry";
import { GitService } from "../git/git.service";
import { SettingsService } from "../settings/settings.service";
import { WorkspaceService } from "../workspace/workspace.service";
import { ShellService } from "./shell.service";

describe("ShellService", () => {
  const activeView = signal("files");
  const sidebarVisible = signal(true);
  const vaultRoot = signal<string | null>("/v");
  const root = signal<string | null>("/v");
  const available = signal(true);
  let shell: ShellService;
  let commands: CommandRegistry;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    activeView.set("files");
    sidebarVisible.set(true);
    vaultRoot.set("/v");
    root.set("/v");
    available.set(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: SettingsService, useValue: { activeView, sidebarVisible } },
        { provide: WorkspaceService, useValue: { vaultRoot, root } },
        { provide: GitService, useValue: { available } },
      ],
    });
    commands = TestBed.inject(CommandRegistry);
    shell = TestBed.inject(ShellService);
  });

  describe("the view switch", () => {
    it("switches to another view and keeps the sidebar open", () => {
      shell.select("search");
      expect(shell.activeView()).toBe("search");
      expect(shell.shownView()).toBe("search");
    });

    it("collapses the sidebar when the active view is chosen, and opens it again", () => {
      shell.select("files");
      expect(shell.shownView()).toBeNull();
      expect(activeView()).toBe("files");
      shell.select("files");
      expect(shell.shownView()).toBe("files");
    });

    it("opens a collapsed sidebar with another view", () => {
      sidebarVisible.set(false);
      shell.select("git");
      expect(shell.shownView()).toBe("git");
    });

    it("runs the command of a tab view or an action and leaves the active view alone", () => {
      const run = vi.fn();
      commands.register({ id: "vault-health", title: "Health", run });
      commands.register({ id: "open-settings", title: "Settings", run });
      shell.select("health");
      shell.select("settings");
      expect(run).toHaveBeenCalledTimes(2);
      expect(shell.activeView()).toBe("files");
      expect(shell.shownView()).toBe("files");
    });

    it("falls back to the files when the Git view is gone, and shows nothing without a folder", () => {
      activeView.set("git");
      available.set(false);
      expect(shell.activeView()).toBe("files");
      root.set(null);
      expect(shell.shownView()).toBeNull();
    });

    it("lists the items of the vault, with the Git view only for a repository", () => {
      expect(shell.items().map((i) => i.id)).toEqual(["files", "search", "bookmarks", "git", "history", "health", "daily-note", "command-palette", "settings"]);
      available.set(false);
      expect(shell.items().map((i) => i.id)).not.toContain("history");
      expect(shell.items().map((i) => i.id)).not.toContain("git");
      vaultRoot.set(null);
      expect(shell.items().map((i) => i.id)).toEqual(["files", "command-palette", "settings"]);
    });
  });

  describe("the commands", () => {
    it("toggle the sidebar", () => {
      commands.execute("toggle-sidebar");
      expect(shell.shownView()).toBeNull();
      commands.execute("toggle-sidebar");
      expect(shell.shownView()).toBe("files");
    });

    it("select the search view, also from a collapsed sidebar, instead of toggling a panel", () => {
      sidebarVisible.set(false);
      expect(commands.execute("search")).toBe(true);
      expect(shell.shownView()).toBe("search");
      commands.execute("search");
      expect(shell.shownView()).toBe("search");
    });

    it("select the Git view only in a repository", () => {
      available.set(false);
      expect(commands.execute("git-changes")).toBe(false);
      available.set(true);
      commands.execute("git-changes");
      expect(shell.shownView()).toBe("git");
    });

    it("select the files", () => {
      activeView.set("search");
      commands.execute("show-files");
      expect(shell.shownView()).toBe("files");
    });

    it("keep the shortcut of the search", () => {
      expect(commands.findByKey({ key: "f", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false })?.id).toBe("search");
    });
  });
});
