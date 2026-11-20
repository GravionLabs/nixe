import { Injectable } from "@angular/core";

import { backend } from "../file/backend";
import { FoldState, normalizeLines, parseFoldState, serializeFoldState } from "./fold-core";

const SAVE_DELAY_MS = 500;

/**
 * Which lines of which note are folded. Kept in the app data directory (`folds.json`), never in the
 * vault, and shared by the editor and the reading view. Loaded on first use; a file that cannot be
 * read is never overwritten.
 */
@Injectable({ providedIn: "root" })
export class FoldStateService {
  private state: FoldState = {};
  private readonly touched = new Set<string>();
  private loading: Promise<void> | null = null;
  private writable = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  private load(): Promise<void> {
    this.loading ??= backend
      .readFolds()
      .then((text) => {
        // Notes changed while reading keep their change.
        const merged = parseFoldState(text);
        for (const path of this.touched) {
          if (this.state[path]) merged[path] = this.state[path];
          else delete merged[path];
        }
        this.state = merged;
        this.writable = true;
      })
      .catch((err) => console.warn("fold state unavailable", err));
    return this.loading;
  }

  /** The folded lines of a note when the file is already read, else null (use `linesOf`). */
  peek(path: string): number[] | null {
    return this.writable ? [...(this.state[path] ?? [])] : null;
  }

  /** The folded start lines (1-based) of a note. */
  async linesOf(path: string): Promise<number[]> {
    await this.load();
    return [...(this.state[path] ?? [])];
  }

  /** Remembers the folded lines of a note (all of them). */
  set(path: string, lines: readonly number[]): void {
    const clean = normalizeLines(lines);
    this.touched.add(path);
    if (clean.length) this.state[path] = clean;
    else delete this.state[path];
    void this.load().then(() => this.schedule());
  }

  /** Writes at once what is pending. */
  async flush(): Promise<void> {
    if (this.timer === undefined) return this.writing;
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.write();
  }

  private schedule(): void {
    if (!this.writable) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.write();
    }, SAVE_DELAY_MS);
  }

  private write(): Promise<void> {
    const content = serializeFoldState(this.state);
    this.writing = this.writing
      .then(() => backend.writeFolds(content))
      .catch((err) => console.warn("fold state not saved", err));
    return this.writing;
  }
}
