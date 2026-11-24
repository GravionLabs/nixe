import type { OnDestroy } from "@angular/core";
import { Component, computed, effect, inject, untracked, viewChild } from "@angular/core";

import { EditorService } from "../../core/editor/editor.service";
import { DocumentService } from "../../core/file/document.service";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { SettingsService } from "../../core/settings/settings.service";
import { CURRENT_TAB, TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { CompareComponent } from "../compare/compare.component";
import { EpubComponent } from "../epub/epub.component";
import { ReviewTabComponent } from "../review/review-tab.component";
import { EditorComponent } from "../editor/editor.component";
import { LogComponent } from "../log/log.component";
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
  imports: [
    CompareComponent,
    LogComponent,
    ReviewTabComponent,
    EditorComponent,
    EpubComponent,
    HealthComponent,
    SettingsComponent,
    StartComponent,
    ViewerComponent,
  ],
  templateUrl: "./pane.component.html",
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      min-width: 0;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--h-message-error-border-color);
      background: var(--h-message-error-background);
      color: light-dark(var(--h-red-700), var(--h-red-300));
    }
    .bar span {
      flex: 1;
    }
    .bar button {
      height: 28px;
      padding: 0 12px;
      border: 1px solid var(--h-content-border-color);
      border-radius: 6px;
      background: var(--h-surface-frame);
      color: var(--h-text-color);
      font: inherit;
      cursor: pointer;
    }
    .bar button:hover {
      background: var(--h-surface-hover);
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
      this.tab.viewer = viewer
        ? {
            topLine: () => viewer.topLine(),
            openFind: () => viewer.openFind(),
            fold: (a) => viewer.fold(a),
          }
        : null;
    });
    // A note opens rendered and editable (#243); the reading view is the user's choice per tab.
    effect(() => {
      const path = this.doc.path();
      const view = this.tab.view();
      untracked(() => {
        if (path === null || view !== null) return;
        this.editor.applyDefaultMode();
        if (this.editor.editing() || this.editor.reading()) return;
        this.editor.toggle(null).catch(() => undefined);
      });
    });
    // A note opened into a tab that shows a view (the sidebar opens into the shown tab) replaces it.
    effect(() => {
      if (this.tab.view() !== null && this.doc.path() !== null) this.tab.view.set(null);
    });
  }

  protected close(): void {
    const pane = this.tabs.panes().find((p) => p.tabs.some((t) => t.id === this.tab.id));
    if (pane) this.tabs.closeTab(pane.id, this.tab.id);
  }

  protected saveCopy(): void {
    void this.editor.handle?.saveCopy();
  }

  ngOnDestroy(): void {
    this.tab.viewer = null;
  }
}
