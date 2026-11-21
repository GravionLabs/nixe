import { Component, Input, computed, inject, signal } from "@angular/core";

import { diffLines } from "../../core/git/line-diff";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/**
 * Two versions of a note, as a line diff with word highlights ("source") or as rendered Markdown
 * side by side ("rendered"). A `null` text is a version that does not exist (an added or deleted
 * note). The one template for every diff of the app.
 */
@Component({
  selector: "app-diff",
  templateUrl: "./diff.component.html",
  styles: `
    :host {
      display: block;
    }

    .status {
      color: var(--h-text-muted-color);
      font-size: 12px;
    }

    .diff {
      font-family: var(--nixe-font-mono, monospace);
      font-size: 12px;
      overflow: auto;
    }

    .row {
      display: flex;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .row .sign {
      flex: none;
      width: 18px;
      text-align: center;
      color: var(--h-text-muted-color);
    }

    .row.add {
      background: rgba(46, 160, 67, 0.15);
    }

    .row.del {
      background: rgba(248, 81, 73, 0.15);
    }

    .row.add .word {
      background: rgba(46, 160, 67, 0.4);
    }

    .row.del .word {
      background: rgba(248, 81, 73, 0.4);
    }

    /* Side by side where there is room, stacked in a narrow panel. */
    .rendered {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }

    .rendered section {
      min-width: 0;
      padding: 0 12px;
      border-top: 1px solid var(--h-content-border-color);
    }

    .rendered h3 {
      font-size: 11px;
      color: var(--h-text-muted-color);
    }
  `,
})
export class DiffComponent {
  private readonly markdown = inject(MarkdownService);
  private readonly workspace = inject(WorkspaceService);

  // The inputs are setters that feed signals, so the computed values below follow them.
  protected readonly before = signal<string | null>(null);
  protected readonly after = signal<string | null>(null);
  protected readonly beforeLabel = signal("Before");
  protected readonly afterLabel = signal("After");
  protected readonly view = signal<"source" | "rendered">("rendered");

  @Input({ required: true }) set oldText(value: string | null) {
    this.before.set(value);
  }
  @Input({ required: true }) set newText(value: string | null) {
    this.after.set(value);
  }
  @Input() set oldLabel(value: string) {
    this.beforeLabel.set(value);
  }
  @Input() set newLabel(value: string) {
    this.afterLabel.set(value);
  }
  @Input() set mode(value: "source" | "rendered") {
    this.view.set(value);
  }

  protected readonly rows = computed(() => diffLines(this.before() ?? "", this.after() ?? ""));
  protected readonly rendered = computed(() => {
    const ctx = {
      filePath: null,
      wikiRoot: null,
      math: false,
      vaultRoot: this.workspace.vaultRoot(),
    };
    const old = this.before();
    const next = this.after();
    return {
      old: old === null ? null : this.markdown.render(old, ctx),
      new: next === null ? null : this.markdown.render(next, ctx),
    };
  });
}
