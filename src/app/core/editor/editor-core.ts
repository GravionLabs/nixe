/**
 * Framework-free logic of the editor (#68): the debounced save, the decision about an external
 * change, the viewer/editor scroll mapping and the inline tokens. No Angular, no CodeMirror.
 */

export const SAVE_IDLE_MS = 1000;

export interface AutoSaverOptions {
  /** Writes the text to disk. */
  write: (text: string) => Promise<void>;
  /** Idle time before a change is written. */
  delayMs?: number;
  /** Called when a write fails; the text stays dirty. */
  onError?: (error: unknown) => void;
}

/**
 * Writes the latest text after `delayMs` without further changes. `flush` writes at once and is
 * what ⌘S, blur, note switch and window close call. Writes never overlap: a flush during a
 * running write waits for it and writes again if the text changed meanwhile.
 */
export class AutoSaver {
  private readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: string | null = null;
  private held = false;
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly options: AutoSaverOptions) {
    this.delayMs = options.delayMs ?? SAVE_IDLE_MS;
  }

  /** Text that was changed and not written yet. */
  get dirty(): boolean {
    return this.pending !== null;
  }

  change(text: string): void {
    this.pending = text;
    clearTimeout(this.timer);
    if (this.held) return;
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  /**
   * While held nothing is written and the text stays dirty (an unresolved external change must
   * not be overwritten). Releasing writes what is pending.
   */
  hold(held: boolean): void {
    this.held = held;
    if (held) clearTimeout(this.timer);
    else if (this.pending !== null) void this.flush();
  }

  /** Drops the pending text without writing it (the editor reloaded the disk version). */
  discard(): void {
    clearTimeout(this.timer);
    this.pending = null;
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.held) return this.running;
    this.running = this.running.then(() => this.writePending());
    return this.running;
  }

  private async writePending(): Promise<void> {
    const text = this.pending;
    if (text === null || this.held) return;
    this.pending = null;
    try {
      await this.options.write(text);
    } catch (error) {
      // A newer change keeps its own text; otherwise the failed one stays dirty for the next flush.
      this.pending ??= text;
      this.options.onError?.(error);
    }
  }
}

export type ExternalChange =
  /** Our own write, or the same text: nothing to do. */
  | "ignore"
  /** The editor has no unsaved changes: take the disk version. */
  | "reload"
  /** The editor has unsaved changes: ask (reload or keep mine). */
  | "conflict";

const REMEMBERED_WRITES = 4;

/**
 * Tells the app's own writes from foreign ones. The watcher reports a path, not who wrote it, so
 * every text that is about to be written is remembered, and a disk text that equals one of them
 * is ignored.
 */
export class ExternalChangeTracker {
  private readonly own: string[] = [];

  /** `text` is what the editor and the disk are known to agree on (opened, reloaded or written). */
  constructor(initial: string) {
    this.remember(initial);
  }

  /** Call before a write starts: its watcher event may arrive before the write resolves. */
  willWrite(text: string): void {
    this.remember(text);
  }

  /** The user chose "reload": the disk text is now the shared one. */
  accept(text: string): void {
    this.remember(text);
  }

  classify(disk: string, dirty: boolean): ExternalChange {
    if (this.own.includes(disk)) return "ignore";
    return dirty ? "conflict" : "reload";
  }

  private remember(text: string): void {
    const at = this.own.indexOf(text);
    if (at >= 0) this.own.splice(at, 1);
    this.own.push(text);
    if (this.own.length > REMEMBERED_WRITES) this.own.shift();
  }
}

export interface LineBlock {
  /** 0-based source line from `data-line`. */
  line: number;
  top: number;
  bottom: number;
}

/**
 * 1-based source line at the top of the viewer: the first block that ends below `viewportTop`.
 * Blocks must be in document order. Null when there are no blocks.
 */
export function viewerTopLine(blocks: readonly LineBlock[], viewportTop: number): number | null {
  if (blocks.length === 0) return null;
  const block = blocks.find((b) => b.bottom > viewportTop) ?? blocks[blocks.length - 1];
  return block.line + 1;
}

/** The 1-based line clamped into the document. */
export function clampLine(line: number, lineCount: number): number {
  return Math.min(Math.max(1, Math.floor(line)), Math.max(1, lineCount));
}

export type InlineTokenKind = "wikilink" | "tag";

export interface InlineToken {
  kind: InlineTokenKind;
  /** Offsets relative to the line. */
  from: number;
  to: number;
  /** Wikilink: the text between the brackets (`Note#Heading|Alias`); tag: the name without `#`. */
  value: string;
}

const WIKILINK = /\[\[([^\[\]\n]+?)\]\]/g;
const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

/** `[[wikilinks]]` and `#tags` of one line, in order of appearance. Code spans are skipped. */
export function inlineTokens(line: string): InlineToken[] {
  const skip = codeSpans(line);
  const inCode = (at: number): boolean => skip.some(([from, to]) => at >= from && at < to);
  const out: InlineToken[] = [];

  for (const m of line.matchAll(WIKILINK)) {
    if (inCode(m.index)) continue;
    out.push({ kind: "wikilink", from: m.index, to: m.index + m[0].length, value: m[1] });
  }

  for (let i = 0; i < line.length; i++) {
    if (line[i] !== "#" || inCode(i)) continue;
    if (i > 0 && !/[\s([{"']/.test(line[i - 1])) continue;
    let end = i + 1;
    while (end < line.length && TAG_CHAR.test(line[end])) end++;
    while (end > i + 1 && /[-/]/.test(line[end - 1])) end--;
    const name = line.slice(i + 1, end);
    if (!name || !/[^\p{N}]/u.test(name.replace(/[-/_]/g, ""))) continue;
    if (name.split("/").some((part) => !part)) continue;
    if (out.some((t) => t.kind === "wikilink" && i >= t.from && i < t.to)) continue;
    out.push({ kind: "tag", from: i, to: end, value: name });
    i = end - 1;
  }
  return out.sort((a, b) => a.from - b.from);
}

/** Offsets `[from, to)` of the inline code spans of a line. */
function codeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const re = /(`+)(?:(?!\1)[\s\S])*?\1/g;
  for (const m of line.matchAll(re)) spans.push([m.index, m.index + m[0].length]);
  return spans;
}

/** The token of `kind` that covers offset `at` of the line, if any. */
export function tokenAt(line: string, at: number, kind?: InlineTokenKind): InlineToken | null {
  return inlineTokens(line).find((t) => at >= t.from && at <= t.to && (!kind || t.kind === kind)) ?? null;
}

/** CSS class of a Lezer Markdown node, or null when the node is not styled. */
export function nodeClass(name: string): string | null {
  const heading = /^ATXHeading([1-6])$/.exec(name) ?? /^SetextHeading([12])$/.exec(name);
  if (heading) return `cm-md-h${heading[1]}`;
  switch (name) {
    case "StrongEmphasis":
      return "cm-md-strong";
    case "Emphasis":
      return "cm-md-em";
    case "InlineCode":
      return "cm-md-code";
    case "HeaderMark":
    case "EmphasisMark":
    case "CodeMark":
    case "QuoteMark":
    case "LinkMark":
    case "ListMark":
      return "cm-md-syntax";
    default:
      return null;
  }
}
