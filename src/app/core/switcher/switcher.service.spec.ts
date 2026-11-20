// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { WorkspaceService } from "../workspace/workspace.service";
import { SwitcherService } from "./switcher.service";

describe("SwitcherService", () => {
  const vaultFiles = signal<string[] | null>(["Alpha.md", "Beta.md", "img.png"]);
  let switcher: SwitcherService;

  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  beforeEach(() => {
    vaultFiles.set(["Alpha.md", "Beta.md", "img.png"]);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: WorkspaceService, useValue: { vaultRoot: signal("/v"), vaultFiles } }],
    });
    switcher = TestBed.inject(SwitcherService);
  });

  it("uses the index, including aliases", async () => {
    vi.spyOn(backend, "notes").mockResolvedValue([{ path: "Home.md", title: "Home", aliases: ["Start"] }]);
    await switcher.open();
    switcher.setQuery("start");
    expect(switcher.current()?.entry.path).toBe("Home.md");
  });

  it("falls back to the Markdown files when the index is unavailable", async () => {
    vi.spyOn(backend, "notes").mockRejectedValue("no index");
    await switcher.open();
    expect(switcher.matches().map((m) => m.entry.path)).toEqual(["Alpha.md", "Beta.md"]);
  });

  it("lists recently opened notes first and moves the selection with wrap-around", async () => {
    vi.spyOn(backend, "notes").mockRejectedValue("no index");
    switcher.noteOpened("/v/Beta.md");
    switcher.noteOpened("/elsewhere/Alpha.md");
    switcher.noteOpened("/v/Alpha.md");
    switcher.noteOpened("/v/Beta.md");
    expect(switcher.recentNotes()).toEqual(["Beta.md", "Alpha.md"]);
    await switcher.open();
    expect(switcher.matches().map((m) => m.entry.path)).toEqual(["Beta.md", "Alpha.md"]);
    switcher.move(-1);
    expect(switcher.current()?.entry.path).toBe("Alpha.md");
    switcher.move(1);
    expect(switcher.current()?.entry.path).toBe("Beta.md");
  });

  it("lists only the recent notes of the current vault", () => {
    const root = TestBed.inject(WorkspaceService).vaultRoot as unknown as ReturnType<typeof signal<string>>;
    switcher.noteOpened("/v/Alpha.md");
    root.set("/w");
    expect(switcher.recentNotes()).toEqual([]);
    switcher.noteOpened("/w/Gamma.md");
    expect(switcher.recentNotes()).toEqual(["Gamma.md"]);
    root.set("/v");
    expect(switcher.recentNotes()).toEqual(["Alpha.md"]);
  });

  it("has no current match when nothing matches, so Enter does nothing", async () => {
    vi.spyOn(backend, "notes").mockRejectedValue("no index");
    await switcher.open();
    switcher.setQuery("zzz");
    expect(switcher.current()).toBeNull();
    switcher.move(1);
    expect(switcher.selected()).toBe(0);
  });

  it("caps the list at 50 and says that more notes match", async () => {
    const notes = Array.from({ length: 51 }, (_, i) => ({ path: `n${i}.md`, title: `n${i}`, aliases: [] }));
    vi.spyOn(backend, "notes").mockResolvedValue(notes);
    await switcher.open();
    expect(switcher.matches()).toHaveLength(50);
    expect(switcher.truncated()).toBe(true);
    switcher.setQuery("n1");
    expect(switcher.truncated()).toBe(false);
  });
});
