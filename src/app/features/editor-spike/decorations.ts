import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { boldMarkers, checkbox, toggledCheckbox } from "./decoration-logic";

const hidden = Decoration.replace({});

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
    box.className = "cm-task-box";
    return box;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;
  const cursorLines = new Set(state.selection.ranges.map((r) => state.doc.lineAt(r.head).number));
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      const box = checkbox(line.text);
      const bold = cursorLines.has(line.number) ? [] : boldMarkers(line.text);
      const items = [
        ...(box
          ? [
              {
                from: box.from,
                to: box.to,
                deco: Decoration.replace({
                  widget: new CheckboxWidget(box.checked),
                }),
              },
            ]
          : []),
        ...bold.map((r) => ({ ...r, deco: hidden })),
      ].sort((a, b) => a.from - b.from);
      for (const i of items) builder.add(line.from + i.from, line.from + i.to, i.deco);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Hides `**` outside the cursor line and shows `- [ ]` as a tappable checkbox. */
export const livePreviewSpike = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view);
      }
    },
    { decorations: (p) => p.decorations },
  ),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("cm-task-box")) return false;
      const pos = view.posAtDOM(target);
      const line = view.state.doc.lineAt(pos);
      const box = checkbox(line.text);
      if (!box) return false;
      view.dispatch({
        changes: {
          from: line.from + box.from,
          to: line.from + box.to,
          insert: toggledCheckbox(box.checked),
        },
      });
      event.preventDefault();
      return true;
    },
  }),
];
