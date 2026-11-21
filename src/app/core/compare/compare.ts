/** Two versions of a note for the compare view; `null` text means that version does not exist. */
export interface CompareInput {
  /** The note, vault-relative. */
  path: string;
  /** The title in the header. */
  title: string;
  oldLabel: string;
  newLabel: string;
  oldText: string | null;
  newText: string | null;
}

export type CompareMode = "rendered" | "source";
