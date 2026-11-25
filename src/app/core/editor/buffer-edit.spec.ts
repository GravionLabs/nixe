import { describe, expect, it, vi } from "vitest";

import { editAndSave, type EditedBuffer } from "./buffer-edit";
import { AutoSaver, ExternalChangeTracker } from "./editor-core";

/** An editor on a note whose disk text is `disk.text`. */
function editor(initial = "a: 1\n") {
  const disk = { text: initial, error: null as string | null };
  let text = initial;
  let failure: string | null = null;
  let refusal: string | null = null;
  const tracker = new ExternalChangeTracker(initial);
  const saver = new AutoSaver({
    write: async (next) => {
      if (disk.error !== null) throw disk.error;
      disk.text = next;
      tracker.written(next);
      failure = null;
    },
    onError: (e) => (failure = String(e)),
  });
  const buffer: EditedBuffer = {
    saver,
    tracker,
    text: () => text,
    apply: (next) => {
      text = next;
      saver.change(next);
    },
    readDisk: async () => disk.text,
    external: vi.fn(),
    refusal: () => refusal,
    failure: () => failure,
    clearFailure: () => (failure = null),
  };
  const type = (next: string) => buffer.apply(next);
  return { buffer, disk, saver, type, refuse: (why: string) => (refusal = why) };
}

const add = (text: string) => `${text}b: 2\n`;

describe("editAndSave", () => {
  it("adds the edit to the unsaved changes and saves both at once", async () => {
    const e = editor();
    e.type("a: 1\ntyped\n");
    await editAndSave(e.buffer, add);
    expect(e.buffer.text()).toBe("a: 1\ntyped\nb: 2\n");
    expect(e.disk.text).toBe("a: 1\ntyped\nb: 2\n");
    expect(e.saver.dirty).toBe(false);
  });

  it("changes nothing when the disk is ahead of the editor", async () => {
    const e = editor();
    e.disk.text = "elsewhere\n";
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("changed on disk");
    expect(e.buffer.external).toHaveBeenCalledWith("elsewhere\n");
    expect(e.buffer.text()).toBe("a: 1\n");
    expect(e.disk.text).toBe("elsewhere\n");
  });

  it("changes nothing while the editor refuses edits", async () => {
    const e = editor();
    e.refuse("Choose first.");
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("Choose first.");
    expect(e.buffer.text()).toBe("a: 1\n");
  });

  it("takes the edit back when it cannot be saved", async () => {
    const e = editor();
    e.disk.error = "denied";
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("could not be saved: denied");
    expect(e.buffer.text()).toBe("a: 1\n");
    expect(e.saver.dirty).toBe(false);
  });

  it("keeps the unsaved changes when it takes the edit back", async () => {
    const e = editor();
    e.type("a: 1\ntyped\n");
    e.disk.error = "denied";
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("denied");
    expect(e.buffer.text()).toBe("a: 1\ntyped\n");
    expect(e.saver.pendingText).toBe("a: 1\ntyped\n");
    e.saver.discard();
  });

  it("says that the change stays when the user typed during the failed write", async () => {
    const e = editor();
    e.disk.error = "denied";
    const flush = e.saver.flush.bind(e.saver);
    vi.spyOn(e.saver, "flush").mockImplementation(async () => {
      await flush();
      e.type("a: 1\nb: 2\ntyped\n");
    });
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("stays in the editor: denied");
    expect(e.buffer.text()).toBe("a: 1\nb: 2\ntyped\n");
    e.saver.discard();
  });

  it("leaves the text alone when the change throws", async () => {
    const e = editor();
    await expect(
      editAndSave(e.buffer, () => {
        throw new Error("Invalid frontmatter");
      }),
    ).rejects.toThrow("Invalid frontmatter");
    expect(e.buffer.text()).toBe("a: 1\n");
    expect(e.saver.dirty).toBe(false);
  });
});
