import { Component, Input, computed, output, signal } from "@angular/core";
import { HxButton, HxDialog } from "@gravionlabs/helix-ui";

import { diffLines, diffStat } from "../../core/git/line-diff";

/**
 * The version on disk against the text in the editor (#247): what "Reload" throws away and what
 * "Keep mine" would overwrite on the next save. The lines of the disk version are the old side.
 */
@Component({
  selector: "app-external-compare",
  templateUrl: "./external-compare.component.html",
  styleUrl: "./external-compare.component.css",
  imports: [HxButton, HxDialog],
})
export class ExternalCompareComponent {
  private readonly diskText = signal("");
  private readonly mineText = signal("");

  /** The version on disk. A setter, not a signal input: specs compile components with JIT. */
  @Input({ required: true }) set disk(value: string) {
    this.diskText.set(value);
  }

  /** The text in the editor. */
  @Input({ required: true }) set mine(value: string) {
    this.mineText.set(value);
  }

  readonly reload = output<void>();
  readonly keep = output<void>();
  readonly closed = output<void>();

  protected readonly rows = computed(() => diffLines(this.diskText(), this.mineText()));
  protected readonly stat = computed(() => diffStat(this.rows()));
}
