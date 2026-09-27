import { Component, inject, output } from "@angular/core";

import { DocumentService } from "../../core/file/document.service";
import { SettingsService } from "../../core/settings/settings.service";
import { TreeNode, WorkspaceService } from "../../core/workspace/workspace.service";

const MIN_WIDTH = 160;
const MAX_WIDTH = 600;

@Component({
  selector: "app-sidebar",
  templateUrl: "./sidebar.component.html",
  styleUrl: "./sidebar.component.css",
  host: { "[style.width.px]": "settings.sidebarWidth()" },
})
export class SidebarComponent {
  protected readonly workspace = inject(WorkspaceService);
  protected readonly doc = inject(DocumentService);
  protected readonly settings = inject(SettingsService);
  readonly error = output<string>();

  protected async select(node: TreeNode): Promise<void> {
    try {
      if (node.filePath) {
        await this.doc.open(node.filePath);
        if (node.dirPath && !node.expanded()) await this.workspace.toggle(node, true);
      } else {
        await this.workspace.toggle(node);
      }
    } catch (err) {
      this.error.emit(String(err));
    }
  }

  protected async toggle(node: TreeNode, event: Event): Promise<void> {
    event.stopPropagation();
    await this.workspace.toggle(node);
  }

  protected startResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.settings.sidebarWidth();
    const handle = event.target as HTMLElement;
    handle.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      const width = startWidth + e.clientX - startX;
      this.settings.sidebarWidth.set(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
  }
}
