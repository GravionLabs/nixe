import { NgTemplateOutlet } from "@angular/common";
import { Component, inject } from "@angular/core";

import { EditorService } from "../../core/editor/editor.service";
import { BookmarksService } from "../../core/bookmarks/bookmarks.service";
import { DocumentService } from "../../core/file/document.service";
import { OutlineNode } from "../../core/outline/outline-core";
import { OutlineService } from "../../core/outline/outline.service";

/** Right-hand panel: the headings of the open note as a tree; a click scrolls the note to the heading. */
@Component({
  selector: "app-outline",
  template: `
    <header>Outline</header>
    @if (outline.tree().length === 0) {
      <p class="status">No headings</p>
    } @else {
      <ul class="tree" role="tree">
        <ng-container *ngTemplateOutlet="nodes; context: { $implicit: outline.tree() }" />
      </ul>
    }

    <ng-template #nodes let-list>
      @for (node of list; track node.index) {
        <li role="treeitem" [attr.aria-level]="node.level" [attr.aria-selected]="node.index === outline.current()">
          <button
            type="button"
            class="heading"
            [class.current]="node.index === outline.current()"
            [attr.aria-current]="node.index === outline.current() ? 'location' : null"
            [style.padding-left.px]="12 + (node.level - 1) * 12"
            (click)="go(node)"
            (contextmenu)="bookmark($event, node)"
            title="Right-click to bookmark the heading"
          >
            {{ node.text }}
          </button>
          @if (node.children.length > 0) {
            <ul role="group">
              <ng-container *ngTemplateOutlet="nodes; context: { $implicit: node.children }" />
            </ul>
          }
        </li>
      }
    </ng-template>
  `,
  styleUrl: "./outline.component.css",
  imports: [NgTemplateOutlet],
})
export class OutlineComponent {
  protected readonly outline = inject(OutlineService);
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly bookmarks = inject(BookmarksService);

  protected bookmark(event: MouseEvent, node: OutlineNode): void {
    event.preventDefault();
    const rel = this.bookmarks.relative(this.doc.path());
    if (rel !== null) this.bookmarks.bookmarkHeading(rel, node.text);
  }

  protected go(node: OutlineNode): void {
    const handle = this.editor.editing() ? this.editor.handle : null;
    if (handle) handle.scrollToLine(node.line);
    else this.doc.pendingLine.set(node.line);
  }
}
