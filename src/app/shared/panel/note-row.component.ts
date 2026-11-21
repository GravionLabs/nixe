import { Component, EventEmitter, Input, Output } from "@angular/core";

import { noteLabel } from "./note-label";
import { type ChangeKind, StatusIconComponent } from "./status-icon.component";

/**
 * A list row for a note: the title in normal weight, the folder dimmed behind it, the full path as
 * tooltip. Extra content (`<… rowActions>`) shows on hover and on keyboard focus.
 */
@Component({
  selector: "app-note-row",
  imports: [StatusIconComponent],
  templateUrl: "./note-row.component.html",
  styles: `
    :host {
      display: block;
    }

    .row {
      display: flex;
      align-items: center;
      padding-right: 12px;
    }

    .row:hover,
    .row:focus-within {
      background: var(--h-surface-hover);
    }

    .main {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 6px;
      min-width: 0;
      padding: 4px 12px;
      border: 0;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .main:disabled {
      cursor: default;
      opacity: 0.6;
    }

    .title,
    .folder {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .title {
      flex: 0 1 auto;
      font-weight: 400;
    }

    .folder {
      flex: 1 1 0;
      font-size: 11px;
      color: var(--h-text-muted-color);
    }

    .actions {
      display: none;
      gap: 4px;
      flex: none;
    }

    .row:hover .actions,
    .row:focus-within .actions {
      display: inline-flex;
    }
  `,
})
export class NoteRowComponent {
  @Input({ required: true }) path!: string;
  @Input() kind?: ChangeKind;
  @Input() disabled = false;
  /** Set when the row expands something; it is announced as `aria-expanded`. */
  @Input() expanded?: boolean;
  @Output() readonly activated = new EventEmitter<void>();

  protected get label(): { title: string; folder: string } {
    return noteLabel(this.path);
  }
}
