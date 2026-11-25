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
 * Applies `change` to the text in the editor, with its unsaved changes, and saves it at once.
 * Rejects, without the change, when the note changed on disk or cannot be saved; only when the
 * user typed during a failed write does the change stay in the editor, which the message says.
 */
export async function editAndSave(
  buffer: EditedBuffer,
  change: (text: string) => string,
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
  await buffer.saver.flush();
  // Still dirty without a reason: the user typed on, which the autosave takes care of.
  const reason = buffer.refusal() ?? buffer.failure();
  if (!buffer.saver.dirty || reason === null) return;
  // Text typed during the write cannot be told apart from the edit: both stay.
  if (buffer.text() !== next)
    throw new Error(`The note could not be saved, the change stays in the editor: ${reason}`);
  // The edit is taken back, so that the editor does not write it later.
  buffer.apply(before);
  if (!dirty) buffer.saver.discard();
  throw new Error(`The note could not be saved: ${reason}`);
}
