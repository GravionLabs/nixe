import { WidgetType } from "@codemirror/view";
import type { EditorView } from "@codemirror/view";

import type { Align, TableModel } from "../../core/editor/table-core";
import {
  deleteColumn,
  deleteRow,
  formatTable,
  insertColumn,
  insertRow,
  parseTable,
  setAlign,
  setCell,
} from "../../core/editor/table-core";

/** What the table needs from the live preview: how cell text is drawn and where the block sits. */
export interface TableHooks {
  /** Fills `el` with the rendered Markdown `source`. */
  render(el: HTMLElement, source: string): void;
  /** The range of the table block in the document, or null when the widget is gone. */
  locate(view: EditorView, dom: HTMLElement): { from: number; to: number } | null;
}

/** A cell of the table, 0-based; row 0 is the header. */
interface CellPos {
  row: number;
  col: number;
}

const editors = new WeakMap<HTMLElement, TableEditor>();

/** An editable table: every cell is a text field; a change rewrites the whole block as one transaction. */
export class TableWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly hooks: TableHooks,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  override toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("div");
    el.className = "cm-live-block cm-live-table markdown-body";
    editors.set(el, new TableEditor(el, view, this.hooks, this.source));
    return el;
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const editor = editors.get(dom);
    if (!editor) return false;
    editor.sync(this.source, view);
    return true;
  }

  override destroy(dom: HTMLElement): void {
    editors.get(dom)?.closeMenu();
    editors.delete(dom);
  }

  /** The cells handle their own events. */
  override ignoreEvent(): boolean {
    return true;
  }
}

const MENU: readonly { label: string; run: (e: TableEditor, at: CellPos) => void }[] = [
  { label: "Add row above", run: (e, at) => e.edit((m) => insertRow(m, at.row), at) },
  {
    label: "Add row below",
    run: (e, at) => e.edit((m) => insertRow(m, at.row + 1), { row: at.row + 1, col: at.col }),
  },
  { label: "Add column left", run: (e, at) => e.edit((m) => insertColumn(m, at.col), at) },
  {
    label: "Add column right",
    run: (e, at) => e.edit((m) => insertColumn(m, at.col + 1), { row: at.row, col: at.col + 1 }),
  },
  { label: "Delete row", run: (e, at) => e.edit((m) => deleteRow(m, at.row)) },
  { label: "Delete column", run: (e, at) => e.edit((m) => deleteColumn(m, at.col)) },
  { label: "Align left", run: (e, at) => e.edit((m) => setAlign(m, at.col, "left")) },
  { label: "Align centre", run: (e, at) => e.edit((m) => setAlign(m, at.col, "center")) },
  { label: "Align right", run: (e, at) => e.edit((m) => setAlign(m, at.col, "right")) },
  { label: "Edit as source", run: (e, at) => e.showSource(at) },
];

class TableEditor {
  private model: TableModel;
  private source: string;
  private table = document.createElement("table");
  private menu: HTMLElement | null = null;
  private away: ((e: Event) => void) | null = null;
  private pendingFocus: CellPos | null = null;

  constructor(
    private readonly el: HTMLElement,
    private view: EditorView,
    private readonly hooks: TableHooks,
    source: string,
  ) {
    this.source = source;
    this.model = parseTable(source.split("\n"));
    el.append(this.table);
    this.build();
    this.table.addEventListener("input", (e) => this.onInput(e));
    this.table.addEventListener("focusin", (e) => this.onFocusIn(e));
    this.table.addEventListener("focusout", (e) => this.onFocusOut(e));
    this.table.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.table.addEventListener("contextmenu", (e) => this.onContextMenu(e));
  }

  /** The document changed under the widget: take the new text over without losing the cell being typed in. */
  sync(source: string, view: EditorView): void {
    this.view = view;
    if (source === this.source) return;
    this.source = source;
    const next = parseTable(source.split("\n"));
    const same =
      next.rows.length === this.table.rows.length &&
      next.aligns.length === (this.table.rows[0]?.cells.length ?? 0);
    this.model = next;
    if (!same) {
      this.build();
    } else {
      this.cells().forEach((tds, r) =>
        tds.forEach((td, c) => {
          td.style.textAlign = alignCss(next.aligns[c]);
          if (td !== document.activeElement && this.shown.get(td) !== next.rows[r][c])
            this.draw(td, next.rows[r][c]);
        }),
      );
    }
    this.applyPendingFocus();
  }

  /** Applies an edit of the model to the note, and puts the cursor into the cell `focus` afterwards. */
  edit(change: (model: TableModel) => TableModel, focus?: CellPos): void {
    this.closeMenu();
    const next = change(this.model);
    if (next === this.model) return;
    this.pendingFocus = focus ?? this.focused() ?? null;
    if (!this.write(next)) this.pendingFocus = null;
    else this.applyPendingFocus();
  }

  /** The cursor goes into the source of the table, near the row, so it shows as Markdown. */
  showSource(at: CellPos): void {
    this.closeMenu();
    const range = this.hooks.locate(this.view, this.el);
    if (!range) return;
    const { doc } = this.view.state;
    const start = doc.lineAt(range.from).number;
    const line = doc.line(
      Math.min(start + (at.row === 0 ? 0 : at.row + 1), doc.lineAt(range.to).number),
    );
    this.view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
    this.view.focus();
  }

  closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
    if (this.away) document.removeEventListener("mousedown", this.away, true);
    this.away = null;
  }

  private shown = new WeakMap<HTMLElement, string>();

  private cells(): HTMLElement[][] {
    return [...this.table.rows].map((r) => [...r.cells]);
  }

  private pos(td: Element | null): CellPos | null {
    const cell = td?.closest("td, th");
    if (!(cell instanceof HTMLTableCellElement)) return null;
    return { row: (cell.parentElement as HTMLTableRowElement).rowIndex, col: cell.cellIndex };
  }

  private focused(): CellPos | undefined {
    return this.pos(document.activeElement) ?? undefined;
  }

  private build(): void {
    this.table.replaceChildren();
    const head = this.table.createTHead();
    const body = this.table.createTBody();
    this.model.rows.forEach((row, r) => {
      const tr = (r === 0 ? head : body).insertRow();
      row.forEach((text, c) => {
        const td = document.createElement(r === 0 ? "th" : "td");
        td.setAttribute("contenteditable", "plaintext-only");
        td.spellcheck = false;
        td.style.textAlign = alignCss(this.model.aligns[c]);
        this.draw(td, text);
        tr.append(td);
      });
    });
  }

  /** A cell is drawn as Markdown, except the one with the cursor, which shows its text. */
  private draw(td: HTMLElement, text: string, raw = false): void {
    this.shown.set(td, text);
    if (raw || !text) {
      td.textContent = text;
      return;
    }
    const tmp = document.createElement("div");
    this.hooks.render(tmp, text);
    const only = tmp.children.length === 1 ? tmp.children[0] : null;
    td.replaceChildren(...(only?.tagName === "P" ? only.childNodes : tmp.childNodes));
  }

  private applyPendingFocus(): void {
    const at = this.pendingFocus;
    this.pendingFocus = null;
    if (!at) return;
    const td = this.cells()[at.row]?.[at.col];
    if (!td) return;
    td.focus();
    const sel = td.ownerDocument.getSelection();
    if (sel) {
      sel.selectAllChildren(td);
      sel.collapseToEnd();
    }
  }

  /** Writes the table into the note as one change; false when the block is gone. */
  private write(next: TableModel): boolean {
    const range = this.hooks.locate(this.view, this.el);
    if (!range) return false;
    const text = formatTable(next).join("\n");
    this.model = next;
    if (text === this.view.state.sliceDoc(range.from, range.to)) return true;
    this.view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      userEvent: "input.table",
    });
    return true;
  }

  private onInput(event: Event): void {
    const at = this.pos(event.target as Element);
    if (!at) return;
    const td = this.cells()[at.row][at.col];
    const text = td.textContent ?? "";
    this.shown.set(td, text);
    this.write(setCell(this.model, at.row, at.col, text));
  }

  private onFocusIn(event: Event): void {
    const at = this.pos(event.target as Element);
    if (!at) return;
    const td = this.cells()[at.row][at.col];
    if (td.textContent === this.model.rows[at.row][at.col]) return;
    this.draw(td, this.model.rows[at.row][at.col], true);
    const sel = td.ownerDocument.getSelection();
    if (sel) {
      sel.selectAllChildren(td);
      sel.collapseToEnd();
    }
  }

  private onFocusOut(event: Event): void {
    const at = this.pos(event.target as Element);
    if (!at) return;
    const td = this.cells()[at.row]?.[at.col];
    if (td) this.draw(td, this.model.rows[at.row][at.col]);
  }

  private onKeyDown(event: KeyboardEvent): void {
    const at = this.pos(event.target as Element);
    if (!at || event.isComposing) return;
    const last = this.model.rows.length - 1;
    const cols = this.model.aligns.length;
    if (event.key === "Tab") {
      event.preventDefault();
      const index = at.row * cols + at.col + (event.shiftKey ? -1 : 1);
      if (index < 0) return;
      if (index >= (last + 1) * cols) {
        this.edit((m) => insertRow(m, last + 1), { row: last + 1, col: 0 });
        return;
      }
      this.focusCell({ row: Math.floor(index / cols), col: index % cols });
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (at.row < last) this.focusCell({ row: at.row + 1, col: at.col });
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (this.menu) this.closeMenu();
      else this.leave();
    }
  }

  private focusCell(at: CellPos): void {
    this.pendingFocus = at;
    this.applyPendingFocus();
  }

  /** The cursor leaves the table: it goes to the line after, or before when the table ends the note. */
  private leave(): void {
    const range = this.hooks.locate(this.view, this.el);
    const doc = this.view.state.doc;
    if (range) {
      const target = range.to < doc.length ? range.to + 1 : range.from > 0 ? range.from - 1 : null;
      if (target !== null)
        this.view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
    }
    this.view.focus();
  }

  private onContextMenu(event: MouseEvent): void {
    const at = this.pos(event.target as Element);
    if (!at) return;
    event.preventDefault();
    this.closeMenu();
    const menu = document.createElement("div");
    menu.className = "cm-live-table-menu";
    menu.setAttribute("role", "menu");
    menu.style.left = `${event.clientX}px`;
    menu.style.top = `${event.clientY}px`;
    for (const item of MENU) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = item.label;
      // The header has no row above it and cannot be deleted.
      button.disabled =
        at.row === 0 && (item.label === "Add row above" || item.label === "Delete row");
      button.addEventListener("mousedown", (e) => e.preventDefault());
      button.addEventListener("click", () => item.run(this, at));
      menu.append(button);
    }
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeMenu();
    });
    this.el.append(menu);
    this.menu = menu;
    this.away = (e) => {
      if (!menu.contains(e.target as Node)) this.closeMenu();
    };
    document.addEventListener("mousedown", this.away, true);
  }
}

function alignCss(align: Align): string {
  return align ?? "";
}
