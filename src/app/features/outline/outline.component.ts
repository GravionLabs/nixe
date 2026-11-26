import { Component, computed, inject } from "@angular/core";
import { HxButton, HxList, HxListRow } from "@gravionlabs/helix-ui";

import { EditorService } from "../../core/editor/editor.service";
import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { DocumentService } from "../../core/file/document.service";
import type { OutlineNode } from "../../core/outline/outline-core";
import { OutlineService } from "../../core/outline/outline.service";

/** Right-hand panel: the headings of the open note as a tree; a click scrolls the note to the heading. */
@Component({
  selector: "app-outline",
  templateUrl: "./outline.component.html",
  styleUrl: "./outline.component.css",
  imports: [HxList, HxListRow, HxButton],
})
export class OutlineComponent {
  protected readonly outline = inject(OutlineService);
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly bookmarks = inject(BookmarksService);

  /** The headings that show, in document order: the children of a folded heading are left out. */
  protected readonly visible = computed(() => {
    const folded = this.outline.folded();
    const flatten = (nodes: readonly OutlineNode[]): OutlineNode[] =>
      nodes.flatMap((n) => [n, ...(folded.has(n.index) ? [] : flatten(n.children))]);
    return flatten(this.outline.tree());
  });

  protected bookmark(event: MouseEvent, node: OutlineNode): void {
    event.preventDefault();
    const rel = this.bookmarks.relative(this.doc.path());
    if (rel !== null) this.bookmarks.bookmarkHeading(rel, node.text);
  }

  protected go(node: OutlineNode): void {
    const handle = this.editor.editing() ? this.editor.handle : null;
    this.doc.jump({ line: node.line }, () => {
      if (handle) handle.scrollToLine(node.line);
      else this.doc.pendingLine.set(node.line);
      return true;
    });
  }
}
