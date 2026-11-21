// @vitest-environment jsdom
// The history of the demo (#403): the log, the history of a note, its versions and what changed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadApp } from "./harness";

vi.mock("@tauri-apps/api/core", () => import("./mock"));
vi.mock("@tauri-apps/api/event", () => import("./mock"));

let app: ReturnType<typeof loadApp>;
beforeEach(async () => {
  app = loadApp();
});

describe("History of the demo", () => {
  it("lists the commits of the vault, newest first, and pages them", async () => {
    const log = await app.backend.gitVaultLog(0, 100);
    expect(log.map((c) => c.message)).toEqual([
      "ideas: tick the backlinks",
      "docs: link the home note",
      "delete: Scratch",
      "chore: scratch note",
      "docs: describe Nixe",
      "init: the demo vault",
    ]);
    expect(log.every((c) => c.id.length === 40)).toBe(true);
    expect((await app.backend.gitVaultLog(1, 2)).map((c) => c.message)).toEqual([
      "docs: link the home note",
      "delete: Scratch",
    ]);
  });

  it("gives the same history in two runs", async () => {
    const first = await app.backend.gitVaultLog(0, 100);
    app = loadApp();
    expect(await app.backend.gitVaultLog(0, 100)).toEqual(first);
  });

  it("lists the commits that touched a note, with their parent", async () => {
    const history = await app.backend.gitNoteHistory("Projects/Nixe.md", 0, 10);
    expect(history.map((h) => h.message)).toEqual(["docs: describe Nixe", "init: the demo vault"]);
    const log = await app.backend.gitVaultLog(0, 100);
    expect(history[0]!.parent).toBe(log[5]!.id);
    expect(history[0]!.id).toBe(log[4]!.id);
    expect(history[1]!.parent).toBeNull();
    expect(await app.backend.gitNoteHistory("Nope.md", 0, 10)).toEqual([]);
  });

  it("marks the commit of a vault operation", async () => {
    const history = await app.backend.gitNoteHistory("Scratch.md", 0, 10);
    expect(history[0]).toMatchObject({ message: "delete: Scratch", operation: "delete" });
  });

  it("reads a note at a commit, on disk and before it existed", async () => {
    const [head, , , , , first] = await app.backend.gitVaultLog(0, 100);
    expect(await app.backend.gitNoteVersion("Ideas.md", first!.id)).toBe(
      "# Ideas\n\n- [ ] A graph of the notes\n",
    );
    expect(await app.backend.gitNoteVersion("Ideas.md", head!.id)).toContain("- [ ] Backlinks");
    expect(await app.backend.gitNoteVersion("Ideas.md", null)).toContain("- [x] Backlinks");
    expect(await app.backend.gitNoteVersion("Scratch.md", first!.id)).toBe("");
  });

  it("lists what changed between two commits", async () => {
    const log = await app.backend.gitVaultLog(0, 100);
    const first = log[5]!.id;
    expect(await app.backend.gitChangesBetween(first)).toEqual([
      { path: "Projects/Nixe.md", kind: "modified" },
      { path: "Home.md", kind: "modified" },
      { path: "Projects/Helix.md", kind: "modified" },
      { path: "Ideas.md", kind: "modified" },
    ]);
    expect(await app.backend.gitChangesBetween(log[4]!.id, log[2]!.id)).toEqual([]);
  });

  it("finds the commit at a time", async () => {
    const log = await app.backend.gitVaultLog(0, 100);
    expect(await app.backend.gitRevAt(log[1]!.time)).toBe(log[1]!.id);
    expect(await app.backend.gitRevAt(log[5]!.time - 1)).toBeNull();
  });

  it("lists the deleted and the recent notes", async () => {
    const deleted = await app.backend.gitDeletedNotes(10);
    expect(deleted.map((d) => d.path)).toEqual(["Scratch.md"]);
    expect(await app.backend.gitNoteVersion("Scratch.md", deleted[0]!.parent)).toContain("Scratch");
    const recent = await app.backend.gitRecentNotes(10, 3);
    expect(recent.map((r) => r.path)).toEqual(["Ideas.md", "Home.md", "Projects/Helix.md"]);
  });

  it("calls no command nobody answered", () => {
    expect(window.__demoFailures).toBeUndefined();
  });
});
