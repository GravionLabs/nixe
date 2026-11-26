// @vitest-environment jsdom
import "@angular/compiler";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import type { EditorHandle } from "../editor/editor.service";
import { TabsService } from "../tabs/tabs.service";
import { NoteEditService } from "./note-edit.service";

const invokeMock = vi.mocked(invoke);
const PATH = "/v/a.md";
const NOTE = "---\ncount: 1 # c\ntags: [a]\n---\nBody\n";

/** A disk behind the commands; `replace_text_file` refuses like the core. */
function fakeDisk(text = NOTE) {
  const disk = { text };
  invokeMock.mockImplementation(async (command: string, args?: unknown) => {
    const a = args as Record<string, string>;
    if (command === "read_text_file") return disk.text;
    if (command === "find_wiki_root") return "/v";
    if (command === "replace_text_file") {
      if (disk.text !== a["expected"])
        throw "/v/a.md: the note changed on disk; nothing was written";
      disk.text = a["content"]!;
    }
    return undefined;
  });
  return disk;
}

const writes = () => invokeMock.mock.calls.filter(([c]) => c === "replace_text_file");

/** An open editor of a tab, holding `text`. */
function fakeEditor(text: string, dirty = false) {
  const editor = {
    text,
    dirty,
    flushed: 0,
    handle: {
      holdsNote: () => true,
      dirty: () => editor.dirty,
      flush: async () => {
        editor.flushed++;
        editor.dirty = false;
      },
      editText: async (change: (t: string) => string) => {
        editor.text = change(editor.text);
      },
    } as unknown as EditorHandle,
  };
  return editor;
}

function setup() {
  TestBed.resetTestingModule();
  const tabs = TestBed.inject(TabsService);
  return { tabs, edits: TestBed.inject(NoteEditService) };
}

const add = (n: number) => (v: unknown) => (v as number) + n;

describe("NoteEditService", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });
  beforeEach(() => invokeMock.mockReset());

  it("reads a note that is not open, changes it and writes it against what was read", async () => {
    const disk = fakeDisk();
    const { edits } = setup();
    await expect(edits.editProperty(PATH, "count", () => 2)).resolves.toBe(2);
    expect(disk.text).toBe(NOTE.replace("count: 1", "count: 2"));
    expect(writes()[0]![1]).toEqual({ path: PATH, expected: NOTE, content: disk.text });
  });

  it("writes nothing when the value stays", async () => {
    fakeDisk();
    const { edits } = setup();
    await edits.editProperty(PATH, "count", () => 1);
    expect(writes()).toEqual([]);
  });

  it("reports a change on disk in between and does not overwrite it", async () => {
    const disk = fakeDisk();
    const { edits } = setup();
    await expect(
      edits.editProperty(PATH, "count", () => {
        disk.text = "changed elsewhere";
        return 2;
      }),
    ).rejects.toContain("changed on disk");
    expect(disk.text).toBe("changed elsewhere");
  });

  it("applies quick edits of a note in order, also after one that failed", async () => {
    const disk = fakeDisk();
    const { edits } = setup();
    const results = await Promise.allSettled([
      edits.editProperty(PATH, "count", add(1)),
      edits.editProperty(PATH, "count", () => {
        throw new Error("no");
      }),
      edits.editProperty(PATH, "count", add(10)),
      edits.editProperty(PATH, "tags", (v) => [...(v as string[]), "b"]),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(disk.text).toBe("---\ncount: 12 # c\ntags: [a, b]\n---\nBody\n");
  });

  it("gives a tab that only shows the note the written text", async () => {
    const disk = fakeDisk();
    const { tabs, edits } = setup();
    const tab = tabs.activeTab();
    await tab.doc.open(PATH, { watch: false });
    await edits.editProperty(PATH, "count", () => 2);
    expect(tab.doc.content()).toBe(disk.text);
  });

  it("hands the edit to the editor with unsaved changes, after the others have saved", async () => {
    fakeDisk();
    const { tabs, edits } = setup();
    const first = tabs.activeTab();
    await first.doc.open(PATH, { watch: false });
    const second = tabs.newTab();
    await second.doc.open(PATH, { watch: false });
    const third = tabs.newTab();
    await third.doc.open(PATH, { watch: false });
    const clean = fakeEditor(NOTE);
    const typed = fakeEditor(`${NOTE}typed\n`, true);
    const stale = fakeEditor(NOTE, true);
    first.editor.handle = clean.handle;
    second.editor.handle = typed.handle;
    third.editor.handle = stale.handle;

    await edits.editProperty(PATH, "count", () => 2);

    expect(typed.text).toBe(`${NOTE.replace("count: 1", "count: 2")}typed\n`);
    expect([clean.text, stale.text]).toEqual([NOTE, NOTE]);
    expect(stale.flushed).toBe(1);
    expect(writes()).toEqual([]);
  });

  it("waits for the save of an editor that was just closed", async () => {
    const disk = fakeDisk();
    const { tabs, edits } = setup();
    const tab = tabs.activeTab();
    await tab.doc.open(PATH, { watch: false });
    let saved!: () => void;
    tab.editor.settling = new Promise<void>((resolve) => {
      saved = () => {
        disk.text = `${NOTE}typed\n`;
        resolve();
      };
    });
    const edit = edits.editProperty(PATH, "count", () => 2);
    await new Promise((resolve) => setTimeout(resolve));
    expect(writes()).toEqual([]);
    saved();
    await edit;
    expect(disk.text).toBe(`${NOTE.replace("count: 1", "count: 2")}typed\n`);
  });

  it("refuses a note whose tab has changes that could not be saved", async () => {
    fakeDisk();
    const { tabs, edits } = setup();
    const tab = tabs.activeTab();
    await tab.doc.open(PATH, { watch: false });
    tab.editor.unsaved.set(true);
    await expect(edits.editProperty(PATH, "count", () => 2)).rejects.toThrow("not saved");
    expect(writes()).toEqual([]);
  });
});
