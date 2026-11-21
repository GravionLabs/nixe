import { Component, Input } from "@angular/core";

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

const LABELS: Record<ChangeKind, string> = {
  added: "New",
  modified: "Changed",
  deleted: "Deleted",
  renamed: "Renamed",
};
const GLYPHS: Record<ChangeKind, string> = {
  added: "＋",
  modified: "●",
  deleted: "−",
  renamed: "→",
};

/** The state of a note as an icon with a tooltip, instead of the letters A/M/D. */
@Component({
  selector: "app-status-icon",
  templateUrl: "./status-icon.component.html",
  styles: `
    :host {
      display: inline-flex;
      flex: none;
    }
    .icon {
      width: 14px;
      text-align: center;
      font-weight: 700;
    }
    .added {
      color: #2da44e;
    }
    .modified {
      color: #bf8700;
    }
    .deleted {
      color: #cf222e;
    }
    .renamed {
      color: #0969da;
    }
  `,
})
export class StatusIconComponent {
  @Input({ required: true }) kind!: ChangeKind;

  protected get label(): string {
    return LABELS[this.kind];
  }

  protected get glyph(): string {
    return GLYPHS[this.kind];
  }
}
