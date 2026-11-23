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
  /** Called whenever `dirty` flips. */
  onDirtyChange?: (dirty: boolean) => void;
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
  private reported = false;

  constructor(private readonly options: AutoSaverOptions) {
    this.delayMs = options.delayMs ?? SAVE_IDLE_MS;
  }

  /** The changed text that is not written yet. */
  get pendingText(): string | null {
    return this.pending;
  }

  /** Text that was changed and not written yet. */
  get dirty(): boolean {
    return this.pending !== null;
  }

  private report(): void {
    const dirty = this.pending !== null;
    if (dirty === this.reported) return;
    this.reported = dirty;
    this.options.onDirtyChange?.(dirty);
  }

  change(text: string): void {
    this.pending = text;
    this.report();
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
    this.report();
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
    this.report();
    try {
      await this.options.write(text);
    } catch (error) {
      // A newer change keeps its own text; otherwise the failed one stays dirty for the next flush.
      this.pending ??= text;
      this.report();
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

/** How long after a write its watcher event may still arrive. */
export const OWN_WRITE_WINDOW_MS = 2000;

/**
 * Tells the app's own writes from foreign ones. The watcher reports a path, not who wrote it.
 * `base` is the text editor and disk are known to agree on; a disk text equal to it is no change.
 * Texts being written, or written within `OWN_WRITE_WINDOW_MS`, are ignored too (their events
 * arrive late). Anything else is foreign, even if it equals an older text.
 */
export class ExternalChangeTracker {
  private base: string;
  private readonly recent: Array<{ text: string; until: number }> = [];

  constructor(
    initial: string,
    private readonly now: () => number = Date.now,
  ) {
    this.base = initial;
  }

  /** Call before a write starts: its watcher event may arrive before the write resolves. */
  willWrite(text: string): void {
    this.recent.push({ text, until: Number.POSITIVE_INFINITY });
  }

  /** The write of `text` succeeded. */
  written(text: string): void {
    this.base = text;
    for (const r of this.recent)
      if (r.text === text && r.until === Number.POSITIVE_INFINITY)
        r.until = this.now() + OWN_WRITE_WINDOW_MS;
  }

  /** The write of `text` failed: the disk does not have it. */
  failed(text: string): void {
    const at = this.recent.findIndex(
      (r) => r.text === text && r.until === Number.POSITIVE_INFINITY,
    );
    if (at >= 0) this.recent.splice(at, 1);
  }

  /** The user chose "reload": the disk text is now the shared one. */
  accept(text: string): void {
    this.base = text;
    this.recent.length = 0;
  }

  classify(disk: string, dirty: boolean): ExternalChange {
    const now = this.now();
    for (let i = this.recent.length - 1; i >= 0; i--)
      if (this.recent[i].until < now) this.recent.splice(i, 1);
    if (disk === this.base || this.recent.some((r) => r.text === disk)) return "ignore";
    return dirty ? "conflict" : "reload";
  }
}

/** Converts LF to CRLF (CodeMirror normalizes line endings; a CRLF note keeps them on save). */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
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

/** How long the Undo of a reload from the external-change bar stays offered (#247). */
export const UNDO_RELOAD_MS = 10_000;

/** The text a reload throws away: the editor text before it, or null when the reload loses nothing. */
export function discardedByReload(before: string, after: string): string | null {
  return before === after ? null : before;
}

/**
 * The smallest single replacement that turns `from` into `to`: common start and end are kept, so
 * a cursor outside the change stays where it is. Null when the texts are equal.
 */
export function changedRange(
  from: string,
  to: string,
): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);
  let start = 0;
  while (start < max && from[start] === to[start]) start++;
  if (start > 0 && isHighSurrogate(from.charCodeAt(start - 1))) start--;
  let end = 0;
  while (end < max - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
  if (end > 0 && isLowSurrogate(from.charCodeAt(from.length - end))) end--;
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
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

const WIKILINK = /\[\[([^[\]\n]+?)\]\]/g;
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
  return (
    inlineTokens(line).find((t) => at >= t.from && at <= t.to && (!kind || t.kind === kind)) ?? null
  );
}

export type EditorLinkKind = "wikilink" | "markdown" | "url";

export interface EditorLink {
  kind: EditorLinkKind;
  /** Offsets relative to the line. */
  from: number;
  to: number;
  /** Wikilink: the text between the brackets; Markdown link: the href; URL: the URL. */
  target: string;
}

const MARKDOWN_LINK = /(?<!!)\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s\n]*)(?:\s+[^)\n]*)?\)/g;
const BARE_URL = /\b(?:https?:\/\/|mailto:)[^\s<>"'`]+/g;

/** `[[wikilinks]]`, `[text](href)` links and bare URLs of one line, in order. Code spans are skipped. */
export function linkTokens(line: string): EditorLink[] {
  const skip = codeSpans(line);
  const inCode = (at: number): boolean => skip.some(([from, to]) => at >= from && at < to);
  const out: EditorLink[] = [];
  const taken = (at: number): boolean => out.some((l) => at >= l.from && at < l.to);

  for (const t of inlineTokens(line)) {
    if (t.kind === "wikilink")
      out.push({ kind: "wikilink", from: t.from, to: t.to, target: t.value });
  }
  for (const m of line.matchAll(MARKDOWN_LINK)) {
    if (inCode(m.index) || taken(m.index)) continue;
    const href = m[2].replace(/^<|>$/g, "");
    if (!href) continue;
    out.push({ kind: "markdown", from: m.index, to: m.index + m[0].length, target: href });
  }
  for (const m of line.matchAll(BARE_URL)) {
    if (inCode(m.index) || taken(m.index)) continue;
    // Trailing punctuation belongs to the sentence; an unbalanced `)` closes a surrounding one.
    let url = m[0].replace(/[.,;:!?'"*_~]+$/, "");
    while (url.endsWith(")") && url.split("(").length < url.split(")").length)
      url = url.slice(0, -1);
    if (url.replace(/^[a-z]+:(\/\/)?/i, "") === "") continue;
    out.push({ kind: "url", from: m.index, to: m.index + url.length, target: url });
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The link under offset `at` of a line, or null. */
export function linkAt(line: string, at: number): EditorLink | null {
  return linkTokens(line).find((l) => at >= l.from && at <= l.to) ?? null;
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
