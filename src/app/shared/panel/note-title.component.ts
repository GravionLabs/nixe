import { Component, Input } from "@angular/core";

import { noteLabel } from "./note-label";
import { type ChangeKind, StatusIconComponent } from "./status-icon.component";

/**
 * The content of a note row: the status of a change, the title in normal weight and the folder
 * dimmed behind it. It goes into a `button[hx-list-row]`.
 */
@Component({
  selector: "app-note-title",
  imports: [StatusIconComponent],
  templateUrl: "./note-title.component.html",
  styles: `
    :host {
      display: contents;
    }

    .hx-list-row-label {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }

    .title,
    .folder {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .title {
      flex: 0 1 auto;
    }

    .folder {
      flex: 1 1 0;
      font-size: var(--h-font-size-xs);
      color: var(--h-text-muted-color);
    }
  `,
})
export class NoteTitleComponent {
  @Input({ required: true }) path!: string;
  @Input() kind?: ChangeKind;

  protected get label(): { title: string; folder: string } {
    return noteLabel(this.path);
  }
}
