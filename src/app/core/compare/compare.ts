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
  /** A button under the title with a note, e.g. "Restore"; `run` resolves true when it is done. */
  action?: { label: string; note: string; run: () => Promise<boolean> };
}

export type CompareMode = "rendered" | "source";
