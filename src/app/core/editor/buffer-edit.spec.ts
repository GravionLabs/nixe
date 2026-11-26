import { describe, expect, it, vi } from "vitest";

import { editAndSave, editsDone, watchedChange, type EditedBuffer } from "./buffer-edit";
import { AutoSaver, ExternalChangeTracker } from "./editor-core";

/** An editor on a note whose disk text is `disk.text`. */
function editor(initial = "a: 1\n") {
  const disk = {
    text: initial,
    error: null as string | null,
    /** Runs right after the editor read the disk: another program writing the note. */
    afterRead: null as (() => void) | null,
    /** Runs while a checked write is under way, before the disk is compared. */
    duringWrite: null as (() => void) | null,
  };
  let text = initial;
  let failure: string | null = null;
  let refusal: string | null = null;
  const tracker = new ExternalChangeTracker(initial);
  const saver = new AutoSaver({
    write: async (next, expected) => {
      if (expected !== undefined) {
        const during = disk.duringWrite;
        disk.duringWrite = null;
        during?.();
        await Promise.resolve();
      }
      if (disk.error !== null) throw disk.error;
      if (expected !== undefined && disk.text !== expected)
        throw "the note changed on disk; nothing was written";
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
    readDisk: async () => {
      const read = disk.text;
      const after = disk.afterRead;
      disk.afterRead = null;
      after?.();
      return read;
    },
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
    e.disk.duringWrite = () => e.type("a: 1\nb: 2\ntyped\n");
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("stays in the editor: denied");
    expect(e.buffer.text()).toBe("a: 1\nb: 2\ntyped\n");
    e.saver.discard();
  });

  it("does not overwrite a change made on disk after the disk check", async () => {
    const e = editor();
    e.disk.afterRead = () => (e.disk.text = "a: 1\nexternal: yes\n");
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("changed on disk");
    expect(e.disk.text).toBe("a: 1\nexternal: yes\n");
    expect(e.buffer.external).toHaveBeenCalledWith("a: 1\nexternal: yes\n");
    expect(e.buffer.text()).toBe("a: 1\n");
    expect(e.saver.dirty).toBe(false);
  });

  it("keeps the unsaved text when the disk changed after the check", async () => {
    const e = editor();
    e.type("a: 1\ntyped\n");
    e.disk.afterRead = () => (e.disk.text = "external\n");
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("changed on disk");
    expect(e.disk.text).toBe("external\n");
    expect(e.buffer.external).toHaveBeenCalledWith("external\n");
    expect(e.buffer.text()).toBe("a: 1\ntyped\n");
    e.saver.discard();
  });

  it("does not write unsaved text over a change made before the edit", async () => {
    const e = editor();
    e.type("a: 1\ntyped\n");
    e.disk.text = "external\n";
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("changed on disk");
    expect(e.disk.text).toBe("external\n");
    expect(e.buffer.external).toHaveBeenCalledWith("external\n");
    expect(e.buffer.text()).toBe("a: 1\ntyped\n");
    e.saver.discard();
  });

  it("saves unsaved text and the edit in one write", async () => {
    const e = editor();
    e.type("a: 1\ntyped\n");
    await editAndSave(e.buffer, add);
    expect(e.disk.text).toBe("a: 1\ntyped\nb: 2\n");
    expect(e.buffer.external).not.toHaveBeenCalled();
  });

  it("waits for a write that is under way before it checks the disk", async () => {
    const e = editor();
    e.type("a: 1\ntyped\n");
    const under = e.saver.flush();
    await editAndSave(e.buffer, add);
    await under;
    expect(e.disk.text).toBe("a: 1\ntyped\nb: 2\n");
  });

  it("lets no flush write the edit unchecked while it is under way", async () => {
    const e = editor();
    let flushed: Promise<void> | undefined;
    e.disk.duringWrite = () => {
      e.disk.text = "external\n";
      // A blur or ⌘S while the checked write runs.
      flushed = e.saver.flush();
    };
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("changed on disk");
    await flushed;
    expect(e.disk.text).toBe("external\n");
    expect(e.buffer.text()).toBe("a: 1\n");
    expect(e.saver.dirty).toBe(false);
  });

  it("judges a change the watcher reports during the edit only after it", async () => {
    const e = editor();
    const external = vi.fn();
    e.disk.duringWrite = () => {
      e.disk.text = "external\n";
      watchedChange(e.saver, e.disk.text, async () => e.disk.text, external);
      expect(external).not.toHaveBeenCalled();
    };
    await expect(editAndSave(e.buffer, add)).rejects.toThrow("changed on disk");
    expect(e.buffer.text()).toBe("a: 1\n");
    await vi.waitFor(() => expect(external).toHaveBeenCalledWith("external\n"));
    expect(e.saver.busy).toBeNull();
  });

  it("takes a change the watcher reports at once when no edit runs", () => {
    const e = editor();
    const external = vi.fn();
    watchedChange(e.saver, "external\n", async () => "", external);
    expect(external).toHaveBeenCalledWith("external\n");
  });

  it("checks only the write of the edit", async () => {
    const e = editor();
    await editAndSave(e.buffer, add);
    // A later autosave is not checked against the disk text of the edit.
    e.disk.text = "elsewhere\n";
    e.type("typed\n");
    await e.saver.flush();
    expect(e.disk.text).toBe("typed\n");
  });

  it("is done only after the edit took itself back and kept the unsaved text pending", async () => {
    const e = editor();
    e.type("a: 1\ntyped\n");
    e.disk.afterRead = () => (e.disk.text = "external\n");
    const edit = editAndSave(e.buffer, add).catch((error: unknown) => error);
    // What leaving the editor waits for before it looks for a conflict and the pending text.
    await editsDone(e.saver);
    expect(e.buffer.external).toHaveBeenCalledWith("external\n");
    expect(e.saver.pendingText).toBe("a: 1\ntyped\n");
    await expect(edit).resolves.toBeInstanceOf(Error);
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
