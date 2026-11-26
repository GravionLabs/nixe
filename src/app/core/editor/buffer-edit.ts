/** An edit from outside an open editor (a cell of a base), which has to reach the disk or nothing. */
import type { AutoSaver, ExternalChangeTracker } from "./editor-core";

/** The open editor of a note, as far as such an edit needs it. */
export interface EditedBuffer {
  saver: AutoSaver;
  tracker: ExternalChangeTracker;
  /** The text in the editor. */
  text(): string;
  /** Puts `text` into the editor as one change, which the saver and the other tabs receive. */
  apply(text: string): void;
  readDisk(): Promise<string>;
  /** Takes over what changed on disk: reloads, or asks the user. */
  external(disk: string): void;
  /** Why no edit can be made now; null when it can. */
  refusal(): string | null;
  /** Why the last write failed; null after one that worked. Reset by `clearFailure`. */
  failure(): string | null;
  clearFailure(): void;
}

/**
 * A change on disk that the watcher reported. While an edit holds the saver it is not judged yet:
 * the edit checks the disk itself, and the disk is read again when it ended.
 */
export function watchedChange(
  saver: AutoSaver,
  disk: string,
  readDisk: () => Promise<string>,
  external: (disk: string) => void,
): void {
  const busy = saver.busy;
  if (!busy) return external(disk);
  // A file that cannot be read by now is reported by its own watcher event.
  void busy
    .then(readDisk)
    .then((now) => watchedChange(saver, now, readDisk, external))
    .catch(() => undefined);
}

/**
 * Resolves when no edit holds the saver. What happens to the pending text when the editor is left
 * (written, or a conflict that needs a copy) is only known then.
 */
export async function editsDone(saver: AutoSaver): Promise<void> {
  while (saver.busy) await saver.busy;
}

/**
 * Applies `change` to the text in the editor, with its unsaved changes, and saves it at once.
 * The write goes through only while the disk holds what was checked. Rejects, without the change,
 * when the note changed on disk or cannot be saved; only when the user typed during a failed
 * write does the change stay in the editor, which the message says.
 */
export function editAndSave(buffer: EditedBuffer, change: (text: string) => string): Promise<void> {
  // No other write runs between the check and the end of the edit, which would be unchecked.
  return buffer.saver.exclusive((write) => checkedEdit(buffer, change, write));
}

async function checkedEdit(
  buffer: EditedBuffer,
  change: (text: string) => string,
  write: (expected: string) => Promise<void>,
): Promise<void> {
  const assertAllowed = () => {
    const reason = buffer.refusal();
    if (reason !== null) throw new Error(reason);
  };
  assertAllowed();
  // Only the note of the focused tab is watched: the disk may be ahead without a notice.
  const disk = await buffer.readDisk();
  assertAllowed();
  if (buffer.tracker.classify(disk, buffer.saver.dirty) !== "ignore") {
    buffer.external(disk);
    throw new Error("The note changed on disk; the value was not written.");
  }
  const before = buffer.text();
  const next = change(before);
  const dirty = buffer.saver.dirty;
  buffer.clearFailure();
  buffer.apply(next);
  await write(disk);
  // Still dirty without a reason: the user typed on, which the autosave takes care of.
  const reason = buffer.refusal() ?? buffer.failure();
  if (!buffer.saver.dirty || reason === null) return;
  // Another program may have written the note between the check and the write.
  const read = await buffer.readDisk().catch(() => null);
  const changed = read !== null && buffer.tracker.classify(read, dirty) !== "ignore" ? read : null;
  const why = changed !== null ? "it changed on disk" : reason;
  // Text typed during the write cannot be told apart from the edit: both stay.
  if (buffer.text() !== next) {
    if (changed !== null) buffer.external(changed);
    throw new Error(`The note could not be saved, the change stays in the editor: ${why}`);
  }
  // The edit is taken back, so that the editor does not write it later.
  buffer.apply(before);
  if (!dirty) buffer.saver.discard();
  // Right after, before the autosave of the unsaved text runs: a conflict holds it.
  if (changed !== null) {
    buffer.external(changed);
    throw new Error("The note changed on disk; the value was not written.");
  }
  throw new Error(`The note could not be saved: ${reason}`);
}
