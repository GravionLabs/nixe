import type { ElementRef } from "@angular/core";
import { Component, EventEmitter, Input, Output, ViewChild, signal } from "@angular/core";

import type { PropertyChange } from "../../core/markdown/property-change";
import { cellText } from "./cell-text";
import { addItem, cellItems, removeItem, typedChange, type CellEditor } from "./cell-edit";

/**
 * An editable cell of a base table: it shows the value and, after a click, the input of its type.
 * It never writes: every change is handed to the table.
 */
@Component({
  selector: "app-base-cell",
  templateUrl: "./base-cell.component.html",
  styleUrl: "./base-cell.component.css",
})
export class BaseCellComponent {
  // Decorators, not signal inputs and queries: the JIT-compiled specs support only these.
  @Input({ required: true }) editor!: CellEditor;
  /** The name of the note property. */
  @Input({ required: true }) property!: string;
  @Input({ required: true }) value: unknown;
  /** The value as the cell shows it. */
  @Input({ required: true }) text!: string;
  /** What the controls are called: the column and the note. */
  @Input({ required: true }) label!: string;
  @Output() readonly changed = new EventEmitter<PropertyChange>();

  /** The input that replaced the value takes the focus. */
  @ViewChild("field") set field(field: ElementRef<HTMLElement> | undefined) {
    field?.nativeElement.focus();
  }

  /** The text the input starts with; null while the value is shown. */
  protected readonly draft = signal<string | null>(null);

  protected get isList(): boolean {
    return this.editor === "list" || this.editor === "tags";
  }

  protected get items(): unknown[] {
    return cellItems(this.property, this.value);
  }

  protected start(): void {
    const value = this.value;
    const empty = this.isList || value === null || value === undefined;
    this.draft.set(empty ? "" : cellText({ type: "text", value }));
  }

  protected cancel(): void {
    this.draft.set(null);
  }

  /** Takes the input and shows the value again. */
  protected commit(input: HTMLInputElement | HTMLTextAreaElement): void {
    const before = this.draft();
    if (before === null) return;
    this.draft.set(null);
    // A date or a number that is typed halfway has an empty value: it changes nothing.
    if (input.value === before || input.validity.badInput) return;
    const change = typedChange(this.editor, input.value);
    if (change) this.changed.emit(change);
  }

  protected toggle(input: HTMLInputElement): void {
    const checked = input.checked;
    // The box shows the value again until the edit is taken: a write that fails at once changes
    // nothing that would reset it.
    input.checked = this.value === true;
    input.indeterminate = this.value === null;
    this.changed.emit(() => checked);
  }

  protected add(input: HTMLInputElement): void {
    const change = addItem(this.property, input.value);
    input.value = "";
    if (change) this.changed.emit(change);
  }

  protected remove(item: unknown, input: HTMLInputElement): void {
    // The button goes away with its item: the focus stays in the cell.
    input.focus();
    this.changed.emit(removeItem(this.property, item));
  }

  protected onListKey(event: KeyboardEvent, input: HTMLInputElement): void {
    if (event.key === "Escape") {
      input.value = "";
      this.cancel();
    } else if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      this.add(input);
    }
  }

  /** The focus left the list editor: a typed item is added and the value is shown again. */
  protected leaveList(event: FocusEvent, box: HTMLElement, input: HTMLInputElement): void {
    if (this.draft() === null || box.contains(event.relatedTarget as Node | null)) return;
    this.add(input);
    this.cancel();
  }
}
