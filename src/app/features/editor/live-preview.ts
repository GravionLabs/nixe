import type { EditorState, Extension, Range } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";

import type { Block, BlockKind } from "../../core/editor/live-preview-core";
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

/** Block widgets for every widget block that no selection touches. */
function blockDecorations(state: EditorState, hooks: LivePreviewHooks): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const block of state.field(blocksField)) {
    if (!WIDGET_KINDS.has(block.kind)) continue;
    const from = state.doc.line(block.start + 1).from;
    const to = state.doc.line(block.end + 1).to;
    if (state.selection.ranges.some((r) => touches(r.from, r.to, from, to))) continue;
    ranges.push(
      Decoration.replace({
        widget: new BlockWidget(state.sliceDoc(from, to), block.kind, hooks),
        block: true,
      }).range(from, to),
    );
  }
  return Decoration.set(ranges);
}

/** Lines (0-based) that show their source: the span of the selection, widened to whole blocks. */
function sourceLines(state: EditorState): { start: number; end: number }[] {
  const { doc } = state;
  const at = (n: number) => doc.line(n + 1).text;
  return state.selection.ranges.map((r) => {
    const a = sourceSpan(at, doc.lines, doc.lineAt(r.from).number - 1);
    const b = sourceSpan(at, doc.lines, doc.lineAt(r.to).number - 1);
    return { start: a.start, end: b.end };
  });
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

/** The live preview: every block but the one with the cursor is drawn, the cursor's block is source. */
export function livePreview(hooks: LivePreviewHooks): Extension {
  const blockWidgets = StateField.define<DecorationSet>({
    create: (state) => blockDecorations(state, hooks),
    update: (value, tr) =>
      tr.docChanged || tr.selection ? blockDecorations(tr.state, hooks) : value,
    provide: (field) => EditorView.decorations.from(field),
  });
  return [blocksField, blockWidgets, inlinePreview, taskToggle];
}
