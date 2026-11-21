import { Component, computed, inject, output } from "@angular/core";

import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { OutlineService } from "../../core/outline/outline.service";
import { PropertiesComponent } from "./properties.component";

/**
 * Right-hand panel: the properties of the note in the active tab, edited with the inputs of the
 * properties block (#376). It follows the text of the editor, so unsaved edits show; a change goes
 * into the editor as one undoable edit, and into the file when the note is not being edited.
 */
@Component({
  selector: "app-properties-panel",
  templateUrl: "./properties-panel.component.html",
  styleUrl: "./properties-panel.component.css",
  imports: [PropertiesComponent],
})
export class PropertiesPanelComponent {
  private readonly doc = inject(DocumentService);
  private readonly editor = inject(EditorService);
  private readonly outline = inject(OutlineService);

  readonly failed = output<string>();

  protected readonly text = computed(() => this.outline.editorText() ?? this.doc.content());

  protected async apply(next: string): Promise<void> {
    const handle = this.editor.editing() ? this.editor.handle : null;
    if (handle?.applyText) {
      handle.applyText(next);
      return;
    }
    const path = this.doc.path();
    if (!path) return;
    try {
      await this.doc.write(path, next);
    } catch (err) {
      this.failed.emit(err instanceof Error ? err.message : String(err));
    }
  }
}
