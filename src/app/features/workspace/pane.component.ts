import { Component, OnDestroy, computed, effect, inject, viewChild } from "@angular/core";

import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { SettingsService } from "../../core/settings/settings.service";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { EditorComponent } from "../editor/editor.component";
import { HealthComponent } from "../health/health.component";
import { StartComponent } from "../start/start.component";
import { SettingsComponent } from "../settings/settings.component";
import { ViewerComponent } from "../viewer/viewer.component";

/**
 * The shown tab of a pane. It is created with the tab's injector, so the viewer and the editor
 * inside get the tab's own document and editor state.
 */
@Component({
  selector: "app-pane",
  imports: [EditorComponent, HealthComponent, SettingsComponent, StartComponent, ViewerComponent],
  template: `
    @if (tab.view() === "settings") {
      <app-settings class="view" />
    } @else if (tab.view() === "health") {
      <app-health class="view" (error)="tabs.notice.set($event)" />
    } @else if (doc.path()) {
      @if (editor.editing()) {
        @defer (on immediate) {
          <app-editor class="note" (error)="tabs.notice.set($event)" />
        }
      } @else {
        <app-viewer class="note" [html]="html()" [dark]="settings.dark()" (notify)="tabs.notice.set($event)" />
      }
    } @else {
      <app-start class="view" (error)="tabs.notice.set($event)" />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    .view {
      flex: 1;
      min-width: 0;
    }
    .note {
      flex: 1;
      min-width: 0;
    }
  `,
})
export class PaneComponent implements OnDestroy {
  protected readonly doc = inject(DocumentService);
  protected readonly editor = inject(EditorService);
  protected readonly settings = inject(SettingsService);
  protected readonly tabs = inject(TabsService);
  private readonly markdown = inject(MarkdownService);
  private readonly workspace = inject(WorkspaceService);
  protected readonly tab = inject(CURRENT_TAB);
  private readonly viewer = viewChild(ViewerComponent);


  /** The note's body; its properties are shown (and edited) by the viewer's properties panel. */
  protected readonly html = computed(
    () =>
      this.markdown.renderNote(this.doc.content(), {
        filePath: this.doc.path(),
        wikiRoot: this.doc.wikiRoot(),
        math: this.settings.math(),
        vaultFiles: this.workspace.vaultFiles(),
        vaultRoot: this.workspace.vaultRoot(),
      }).body,
  );

  constructor() {
    effect(() => {
      const viewer = this.viewer();
      this.tab.viewer = viewer ? { topLine: () => viewer.topLine(), openFind: () => viewer.openFind(), fold: (a) => viewer.fold(a) } : null;
    });
    // A note opened into a tab that shows a view (the sidebar opens into the shown tab) replaces it.
    effect(() => {
      if (this.tab.view() !== null && this.doc.path() !== null) this.tab.view.set(null);
    });
  }

  ngOnDestroy(): void {
    this.tab.viewer = null;
  }
}
