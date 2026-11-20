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
    @if (outline.tree().length === 0) {
      <p class="status">No headings</p>
    } @else {
      <div class="levels" role="group" aria-label="Fold the outline">
        <button type="button" class="level" (click)="outline.collapseTo(1)" title="Show only H1">H1</button>
        <button type="button" class="level" (click)="outline.collapseTo(2)" title="Show down to H2">H2</button>
        <button type="button" class="level" (click)="outline.collapseTo(3)" title="Show down to H3">H3</button>
        <button type="button" class="level" (click)="outline.expandAll()" title="Expand all">All</button>
      </div>
      <ul class="tree" role="tree">
        <ng-container *ngTemplateOutlet="nodes; context: { $implicit: outline.tree() }" />
      </ul>
    }

    <ng-template #nodes let-list>
      @for (node of list; track node.index) {
        <li
          role="treeitem"
          [attr.aria-level]="node.level"
          [attr.aria-selected]="node.index === outline.marked()"
          [attr.aria-expanded]="node.children.length > 0 ? !outline.folded().has(node.index) : null"
        >
          @if (node.children.length > 0) {
            <button
              type="button"
              class="fold"
              [style.left.px]="2 + (node.level - 1) * 12"
              [attr.aria-label]="(outline.folded().has(node.index) ? 'Expand ' : 'Collapse ') + node.text"
              (click)="outline.toggle(node.index)"
            >
              {{ outline.folded().has(node.index) ? "▸" : "▾" }}
            </button>
          }
          <button
            type="button"
            class="heading"
            [class.current]="node.index === outline.marked()"
            [attr.aria-current]="node.index === outline.marked() ? 'location' : null"
            [style.padding-left.px]="16 + (node.level - 1) * 12"
            (click)="go(node)"
            (contextmenu)="bookmark($event, node)"
            title="Right-click to bookmark the heading"
          >
            {{ node.text }}
          </button>
          @if (node.children.length > 0 && !outline.folded().has(node.index)) {
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
