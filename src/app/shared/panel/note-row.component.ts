import { Component } from "@angular/core";

/**
 * The line of a note in an `hx-list`: the `button[hx-list-row]` of the caller, between optional
 * content in front of it (`<… rowStart>`) and actions (`<… rowActions>`) that show on hover and on
 * keyboard focus. The row is declared by the caller: an `hx-list` only moves through the rows of its
 * own template.
 */
@Component({
  selector: "app-note-row",
  templateUrl: "./note-row.component.html",
  styles: `
    :host {
      display: flex;
      align-items: center;
    }

    .line {
      flex: 1;
      min-width: 0;
    }

    .actions {
      display: none;
      gap: 4px;
      flex: none;
      padding-right: 12px;
    }

    :host(:hover) .actions,
    :host(:focus-within) .actions {
      display: inline-flex;
    }
  `,
})
export class NoteRowComponent {}
