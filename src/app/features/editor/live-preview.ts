import type { EditorLink } from "../../core/editor/editor-core";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";

import type { Block, BlockKind } from "../../core/editor/live-preview-core";
import { splitFrontmatter } from "../../core/markdown/frontmatter";
import { TableWidget } from "./table-widget";
import type { PropertiesDisplay } from "../../core/settings/settings-core";
import {
  WIDGET_KINDS,
  disjoint,
  findBlocks,
  inlineMarks,
  sourceSpan,
  touches,
} from "../../core/editor/live-preview-core";

/** What the live preview needs from the app to draw a block: the rendering pipeline of the viewer. */
export interface LivePreviewHooks {
  /** Fills `el` with the rendered Markdown `source` (sanitized HTML, then mermaid and embeds). */
  render(el: HTMLElement, source: string, kind: BlockKind): void;
  /**
   * Draws the frontmatter as the properties block of the reading view (#375). Absent: the
   * frontmatter stays source. `actions.edit` replaces the frontmatter text, `actions.showSource`
   * puts the cursor into it.
   */
  mountProperties?(el: HTMLElement, source: string, actions: PropertiesActions): PropertiesHandle;
  /** How the properties show in the document; `hidden` draws no frontmatter at all. */
  propertiesDisplay?(): PropertiesDisplay;
  /** A click on a link drawn in a table cell opens it (`newTab` with ⌘/Ctrl). Absent: the click edits the cell. */
  openLink?(link: EditorLink, newTab: boolean): void;
}

/** What the properties block asks the editor to do. */
export interface PropertiesActions {
  edit(next: string): void;
  showSource(): void;
}

/** A mounted properties block: takes the new frontmatter text, is removed with the widget. */
export interface PropertiesHandle {
  update(source: string): void;
  destroy(): void;
}

/** Elements of a rendered block with a click of their own: links, checkboxes, zoomable images, diagrams. */
const OWN_CLICK = "a, button, input, summary, img, [data-zoomable], .mermaid-diagram";

function hasOwnClick(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OWN_CLICK) !== null;
}

/** Lines of the block source before the clicked row: a table row is its own line, the rest starts at the top. */
function clickedLine(target: Element): number {
  const row = target.closest("tr");
  if (!row) return 0;
  const rows = [...(row.closest("table")?.rows ?? [])];
  const i = rows.indexOf(row);
  // The delimiter row `| - | - |` sits between the header and the first body row and is not rendered.
  return i <= 0 ? 0 : i + 1;
}

class BlockWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly kind: BlockKind,
    private readonly hooks: LivePreviewHooks,
  ) {
    super();
  }

  override eq(other: BlockWidget): boolean {
    return other.source === this.source && other.kind === this.kind;
  }

  override toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-live-block cm-live-${this.kind}`;
    this.hooks.render(el, this.source, this.kind);
    return el;
  }

  /** Pointer events reach the editor, so a click puts the cursor into the block; own clicks stay with the element. */
  override ignoreEvent(event: Event): boolean {
    return hasOwnClick(event.target);
  }
}

/** The frontmatter as the properties block; the block stays alive while the text changes. */
class PropertiesWidget extends WidgetType {
  private static readonly handles = new WeakMap<HTMLElement, PropertiesHandle>();

  constructor(
    private readonly source: string,
    private readonly hooks: LivePreviewHooks,
  ) {
    super();
  }

  /** Folded or not is the block's own business: it follows the setting. */
  override eq(other: PropertiesWidget): boolean {
    return other.source === this.source;
  }

  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-live-properties";
    const handle = this.hooks.mountProperties?.(el, this.source, {
      edit: (next) => replaceFrontmatter(view, next),
      showSource: () => showFrontmatterSource(view),
    });
    if (handle) PropertiesWidget.handles.set(el, handle);
    return el;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const handle = PropertiesWidget.handles.get(dom);
    if (!handle) return false;
    handle.update(this.source);
    return true;
  }

  override destroy(dom: HTMLElement): void {
    PropertiesWidget.handles.get(dom)?.destroy();
    PropertiesWidget.handles.delete(dom);
  }

  /** The inputs of the block handle their events themselves. */
  override ignoreEvent(): boolean {
    return true;
  }
}

class FrontmatterWarningWidget extends WidgetType {
  constructor(private readonly error: string) {
    super();
  }
  override eq(other: FrontmatterWarningWidget): boolean {
    return other.error === this.error;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-live-frontmatter-warning";
    el.setAttribute("role", "alert");
    el.textContent = `Invalid frontmatter: ${this.error}`;
    return el;
  }
}

class BulletWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-live-bullet";
    el.textContent = "•";
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  override toDOM(): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-live-task";
    return box;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const hidden = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });

/** The blocks of the note; recomputed when the text changes only. */
const blocksField = StateField.define<Block[]>({
  create: (state) => findBlocks(state.doc.toJSON()),
  update: (blocks, tr) => (tr.docChanged ? findBlocks(tr.state.doc.toJSON()) : blocks),
});

/** The frontmatter block of the note: the lines from the first to the closing fence. */
function frontmatterRange(state: EditorState): { from: number; to: number } | null {
  const block = state.field(blocksField).find((b) => b.kind === "frontmatter");
  return block ? { from: 0, to: state.doc.line(block.end + 1).to } : null;
}

/** A change made in the properties block: the new text takes the place of the frontmatter. */
function replaceFrontmatter(view: EditorView, next: string): void {
  const range = frontmatterRange(view.state);
  if (range) view.dispatch({ changes: { ...range, insert: next } });
}

/** The cursor goes into the frontmatter, so its YAML shows. */
function showFrontmatterSource(view: EditorView): void {
  const range = frontmatterRange(view.state);
  if (!range) return;
  const line = view.state.doc.line(Math.min(2, view.state.doc.lineAt(range.to).number));
  view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
  view.focus();
}

/**
 * The frontmatter as the properties block (or nothing when hidden). Valid frontmatter only: the
 * YAML of an invalid one stays, with its warning above. A cursor at the very start of the note does
 * not count as being in the frontmatter, or every note would open with its YAML.
 */
function frontmatterDecorations(
  state: EditorState,
  hooks: LivePreviewHooks,
  display: PropertiesDisplay,
): Range<Decoration>[] {
  const range = frontmatterRange(state);
  if (!range) return [];
  const text = state.sliceDoc(range.from, range.to);
  const { error } = splitFrontmatter(text);
  if (error) {
    if (display === "hidden") return [];
    return [
      Decoration.widget({
        widget: new FrontmatterWarningWidget(error),
        block: true,
        side: -1,
      }).range(0),
    ];
  }
  const inside = state.selection.ranges.some(
    (r) => !(r.empty && r.from === 0) && touches(r.from, r.to, range.from, range.to),
  );
  if (inside) return [];
  if (display === "hidden")
    return [Decoration.replace({ block: true }).range(range.from, range.to)];
  if (!hooks.mountProperties) return [];
  return [
    Decoration.replace({
      widget: new PropertiesWidget(text, hooks),
      block: true,
    }).range(range.from, range.to),
  ];
}

/** The range of the table block whose widget is `dom`. */
function locateTable(view: EditorView, dom: HTMLElement): { from: number; to: number } | null {
  let from: number;
  try {
    from = view.posAtDOM(dom);
  } catch {
    return null;
  }
  const { doc } = view.state;
  const line = doc.lineAt(from);
  const block = view.state.field(blocksField).find((b) => b.start === line.number - 1);
  return block?.kind === "table" ? { from: line.from, to: doc.line(block.end + 1).to } : null;
}

function tableHooks(hooks: LivePreviewHooks) {
  return {
    render: (el: HTMLElement, source: string) => hooks.render(el, source, "table"),
    locate: locateTable,
    openLink: hooks.openLink ? (l: EditorLink, n: boolean) => hooks.openLink?.(l, n) : undefined,
  };
}

/** Block widgets for every widget block that no selection touches. */
function blockDecorations(state: EditorState, hooks: LivePreviewHooks): DecorationSet {
  const ranges: Range<Decoration>[] = frontmatterDecorations(
    state,
    hooks,
    hooks.propertiesDisplay?.() ?? "visible",
  );
  for (const block of state.field(blocksField)) {
    if (!WIDGET_KINDS.has(block.kind)) continue;
    const from = state.doc.line(block.start + 1).from;
    const to = state.doc.line(block.end + 1).to;
    if (state.selection.ranges.some((r) => touches(r.from, r.to, from, to))) continue;
    const source = state.sliceDoc(from, to);
    ranges.push(
      Decoration.replace({
        widget:
          block.kind === "table"
            ? new TableWidget(source, tableHooks(hooks))
            : new BlockWidget(source, block.kind, hooks),
        block: true,
      }).range(from, to),
    );
  }
  return Decoration.set(ranges);
}

/** Lines (0-based) that show their source: the span of the selection, widened to whole blocks. */
export function sourceLines(state: EditorState): { start: number; end: number }[] {
  const { doc } = state;
  const at = (n: number) => doc.line(n + 1).text;
  return state.selection.ranges.map((r) => {
    const a = sourceSpan(at, doc.lines, doc.lineAt(r.from).number - 1);
    const b = sourceSpan(at, doc.lines, doc.lineAt(r.to).number - 1);
    return { start: a.start, end: b.end };
  });
}

/** True when the line of `pos` is drawn (outside the cursor's block and not a widget or code block). */
export function isRenderedLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const n = line.number - 1;
  if (state.field(blocksField, false)?.some((b) => b.start <= n && n <= b.end)) return false;
  return !sourceLines(state).some((a) => n >= a.start && n <= a.end);
}

function inlineDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const blocks = state.field(blocksField);
  const active = sourceLines(state);
  const ranges: Range<Decoration>[] = [];
  let b = 0;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      const n = line.number - 1;
      while (b > 0 && blocks[b - 1].end >= n) b--;
      while (b < blocks.length && blocks[b].end < n) b++;
      const block = blocks[b]?.start <= n ? blocks[b] : undefined;
      if (block) {
        if (block.kind === "code")
          ranges.push(Decoration.line({ class: "cm-live-code" }).range(line.from));
        else if (block.kind === "frontmatter")
          ranges.push(Decoration.line({ class: "cm-live-frontmatter" }).range(line.from));
        continue;
      }
      if (line.length === 0 || active.some((a) => n >= a.start && n <= a.end)) continue;
      for (const mark of disjoint(inlineMarks(line.text))) {
        const deco =
          mark.kind === "hide"
            ? hidden
            : mark.kind === "bullet"
              ? bullet
              : Decoration.replace({ widget: new CheckboxWidget(mark.checked === true) });
        ranges.push(deco.range(line.from + mark.from, line.from + mark.to));
      }
    }
  }
  return Decoration.set(ranges, true);
}

/** Hides the syntax of the lines outside the cursor's block and turns task items into checkboxes. */
const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = inlineDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged)
        this.decorations = inlineDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** `- [ ]` ↔ `- [x]` at the checkbox the pointer is on. */
const taskToggle = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("cm-live-task")) return false;
    const pos = view.posAtDOM(target);
    const line = view.state.doc.lineAt(pos);
    const m = /^(\s*[-*+]\s)\[([ xX])\]/.exec(line.text);
    if (!m) return false;
    const at = line.from + m[1].length;
    view.dispatch({ changes: { from: at, to: at + 3, insert: m[2] === " " ? "[x]" : "[ ]" } });
    event.preventDefault();
    return true;
  },
});

/** A click on a rendered block puts the cursor into it, near the row clicked, so its source shows. */
const blockClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target;
    if (event.button !== 0 || !(target instanceof Element) || hasOwnClick(target)) return false;
    const el = target.closest(".cm-live-block");
    // A table takes the click into its cells itself.
    if (!el || el.classList.contains("cm-live-table")) return false;
    const from = view.posAtDOM(el);
    const start = view.state.doc.lineAt(from);
    const block = view.state.field(blocksField).find((b) => b.start === start.number - 1);
    const lineNo = Math.min(
      start.number + clickedLine(target),
      view.state.doc.line((block?.end ?? start.number - 1) + 1).number,
    );
    view.dispatch({ selection: { anchor: view.state.doc.line(lineNo).to }, scrollIntoView: true });
    view.focus();
    event.preventDefault();
    return true;
  },
});

/** The live preview: every block but the one with the cursor is drawn, the cursor's block is source. */
export function livePreview(hooks: LivePreviewHooks): Extension {
  const blockWidgets = StateField.define<DecorationSet>({
    create: (state) => blockDecorations(state, hooks),
    update: (value, tr) =>
      tr.docChanged || tr.selection ? blockDecorations(tr.state, hooks) : value,
    provide: (field) => EditorView.decorations.from(field),
  });
  return [blocksField, blockWidgets, inlinePreview, taskToggle, blockClick];
}
