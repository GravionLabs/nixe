import { Injectable, inject } from "@angular/core";

import { changeProperty, type PropertyChange } from "../markdown/property-change";
import { TabsService } from "../tabs/tabs.service";
import { backend } from "./backend";

/**
 * Changes a property of a note from outside its own tab (a cell of a base). A note with an open
 * editor takes the change in its buffer, which is saved at once; any other note is read, changed
 * and written only while the disk still holds what was read.
 */
@Injectable({ providedIn: "root" })
export class NoteEditService {
  private readonly tabs = inject(TabsService);
  /** The last edit of each note that is under way: the next one starts after it. */
  private readonly queues = new Map<string, Promise<unknown>>();

  /** Resolves with the stored value; rejects, with the note unchanged, when it was not stored. */
  editProperty(path: string, property: string, change: PropertyChange): Promise<unknown> {
    const run = (this.queues.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.run(path, property, change));
    this.queues.set(path, run);
    const done = () => {
      if (this.queues.get(path) === run) this.queues.delete(path);
    };
    run.then(done, done);
    return run;
  }

  private async run(path: string, property: string, change: PropertyChange): Promise<unknown> {
    let value: unknown;
    const apply = (text: string): string => {
      const changed = changeProperty(text, property, change);
      value = changed.value;
      return changed.text;
    };
    // An editor that was just closed may still be saving.
    await Promise.all(this.tabs.tabsOf(path).map((t) => t.editor.settling));
    const tabs = this.tabs.tabsOf(path);
    const editors = tabs.filter((t) => t.editor.handle?.holdsNote?.());
    // The editor with unsaved changes takes the edit; the others follow what it holds.
    const target = editors.find((t) => t.editor.handle?.dirty()) ?? editors[0];
    if (target) {
      // An older text that another editor still has to save must not come after the edit.
      for (const tab of editors) if (tab !== target) await tab.editor.handle?.flush();
      const handle = target.editor.handle;
      if (!handle?.editText) throw new Error("The note was closed while it was changed.");
      await handle.editText(apply);
      return value;
    }
    if (tabs.some((t) => t.editor.unsaved()))
      throw new Error("The note has changes that are not saved: open its tab first.");
    const before = await backend.readTextFile(path);
    const next = apply(before);
    if (next !== before) {
      await backend.replaceTextFile(path, before, next);
      for (const tab of this.tabs.tabsOf(path)) tab.doc.remote(path, next, true);
    }
    return value;
  }
}
