import { Component, EventEmitter, Input, Output } from "@angular/core";
import { HxButton } from "@gravionlabs/helix-ui";

/** A muted text for a list without entries, with an optional action button. */
@Component({
  selector: "app-empty-state",
  imports: [HxButton],
  templateUrl: "./empty-state.component.html",
  styles: `
    :host {
      display: block;
      margin: 4px 12px;
      font-size: 12px;
      color: var(--h-text-muted-color);
    }
    .text {
      margin: 0 0 4px;
    }
  `,
})
export class EmptyStateComponent {
  @Input({ required: true }) text!: string;
  /** Label of the action button; without it no button shows. */
  @Input() action?: string;
  @Output() readonly activated = new EventEmitter<void>();
}
