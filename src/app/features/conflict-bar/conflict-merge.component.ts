import { Component, computed, inject, output, signal } from "@angular/core";
import { HxButton, HxDialog, HxField, HxInput, HxSelectButton } from "@gravionlabs/helix-ui";

import { ConflictService } from "../../core/git/conflict.service";
import { mergeParts, mergeText, type MergeChoice } from "../../core/git/line-diff";

/**
 * Both versions of a sync conflict side by side (#242): the changed hunks are marked and each is
 * taken from this note, the other one or both. The result can be edited before it is saved. The
 * hunk markup follows the review (#109).
 */
@Component({
  selector: "app-conflict-merge",
  templateUrl: "./conflict-merge.component.html",
  styleUrl: "./conflict-merge.component.css",
  imports: [HxButton, HxDialog, HxField, HxInput, HxSelectButton],
})
export class ConflictMergeComponent {
  protected readonly conflict = inject(ConflictService);
  readonly failed = output<string>();

  protected readonly choiceOptions: { label: string; value: MergeChoice }[] = [
    { label: "Take this", value: "this" },
    { label: "Take the other", value: "other" },
    { label: "Take both", value: "both" },
  ];
  protected readonly choices = signal<Record<number, MergeChoice>>({});
  /** The text the user typed into the result; null while the result follows the choices. */
  protected readonly typed = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected readonly parts = computed(() => {
    const m = this.conflict.merging();
    return m ? mergeParts(m.mine, m.theirs) : [];
  });
  protected readonly result = computed(() => {
    const m = this.conflict.merging();
    if (!m) return "";
    return this.typed() ?? mergeText(this.parts(), this.choices(), m.mine.endsWith("\n"));
  });
  protected readonly hunkCount = computed(
    () => this.parts().filter((p) => p.kind === "hunk").length,
  );

  protected choice(index: number): MergeChoice {
    return this.choices()[index] ?? "this";
  }

  protected pick(index: number, choice: MergeChoice): void {
    this.choices.update((c) => ({ ...c, [index]: choice }));
    this.typed.set(null);
  }

  /** Escape, the close button or the mask; also fires when the dialog is destroyed after a save. */
  protected onHidden(): void {
    if (this.conflict.merging()) this.cancel();
  }

  protected cancel(): void {
    this.reset();
    this.conflict.cancelMerge();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.saving()) void this.save();
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    try {
      await this.conflict.saveMerge(this.result());
      this.reset();
    } catch (err) {
      this.failed.emit(String(err));
    } finally {
      this.saving.set(false);
    }
  }

  private reset(): void {
    this.choices.set({});
    this.typed.set(null);
  }
}
