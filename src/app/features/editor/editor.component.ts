import { Component, ElementRef, OnDestroy, effect, inject, output, signal, untracked, viewChild } from "@angular/core";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AutoSaver, ExternalChangeTracker, clampLine, toCrlf } from "../../core/editor/editor-core";
import { EditorService } from "../../core/editor/editor.service";
import { backend } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { isMarkdownPath, joinPath } from "../../core/markdown/paths";
import { parseWikilinkTarget, resolveWikilink } from "../../core/markdown/wikilink-resolver";
import { SettingsService } from "../../core/settings/settings.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { editorBehavior, editorTheme } from "./editor-extensions";

const BASE_FONT_PX = 16;

/** The note being edited: its saver, its view of the disk and the folder a write may reach. */
interface Session {
  path: string;
  /** The note had CRLF line endings; CodeMirror normalizes them, so they are restored on save. */
  crlf: boolean;
  saver: AutoSaver;
  tracker: ExternalChangeTracker;
}

/** CodeMirror 6 editor of the open note. Lives in its own lazy chunk (loaded by `@defer`). */
@Component({
  selector: "app-editor",
  template: `
    @if (conflict() !== null) {
      <div class="bar" role="alert">
        <span>This note changed on disk while you were editing.</span>
        <button type="button" (click)="reloadFromDisk()">Reload</button>
        <button type="button" (click)="keepMine()">Keep mine</button>
      </div>
    }
    <div #host class="host"></div>
  `,
  styleUrl: "./editor.component.css",
})
export class EditorComponent implements OnDestroy {
  readonly error = output<string>();

  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly ops = inject(VaultOpsService);
  private readonly settings = inject(SettingsService);
  private readonly editor = inject(EditorService);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>("host");

  /** The disk text that conflicts with unsaved changes; null when there is no conflict. */
  protected readonly conflict = signal<string | null>(null);

  private readonly theme = new Compartment();
  private view: EditorView | undefined;
  private session: Session | null = null;
  private loading = false;
  private unlistenClose: (() => void) | undefined;
  private destroyed = false;

  constructor() {
    this.editor.handle = {
      topLine: () => this.topLine(),
      flush: () => this.flush(),
      blocked: () => this.conflict() !== null,
    };
    this.doc.editorHook = (path, text) => this.onExternal(path, text);

    effect(() => {
      const path = this.doc.path();
      const host = this.host().nativeElement;
      untracked(() => void this.openNote(path, host));
    });

    effect(() => {
      const dark = this.settings.dark();
      const size = (BASE_FONT_PX * this.settings.zoom()) / 100;
      this.view?.dispatch({ effects: this.theme.reconfigure(editorTheme(dark, size)) });
    });

    void this.watchWindowClose();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.unlistenClose?.();
    void this.settle();
    this.editor.handle = null;
    this.doc.editorHook = null;
    this.view?.destroy();
  }

  private async watchWindowClose(): Promise<void> {
    try {
      const unlisten = await getCurrentWindow().onCloseRequested(async () => {
        await this.settle();
      });
      if (this.destroyed) unlisten();
      else this.unlistenClose = unlisten;
    } catch {
      // No window API (tests, mobile): the other triggers still write.
    }
  }

  /** The note switched: write the old one, then show the new one. */
  private async openNote(path: string | null, host: HTMLElement): Promise<void> {
    await this.settle();
    this.conflict.set(null);
    const current = this.doc.path();
    if (!current || current !== path) {
      // A newer switch is on its way; it opens the note.
      if (!current) this.session = null;
      return;
    }
    if (!(await backend.isUtf8File(current))) {
      this.session = null;
      this.error.emit("This note is not valid UTF-8; editing it would damage it.");
      this.editor.editing.set(false);
      return;
    }
    const text = this.doc.content();
    const session: Session = {
      path: current,
      crlf: text.includes("\r\n"),
      tracker: new ExternalChangeTracker(text),
      saver: new AutoSaver({
        write: (t) => this.write(session, t),
        onError: (e) => this.error.emit(`Saving failed: ${String(e)}`),
      }),
    };
    this.session = session;

    this.loading = true;
    const state = EditorState.create({
      doc: text,
      extensions: [
        editorBehavior({
          onSave: () => void this.flush(),
          onBlur: () => void this.flush(),
          onWikilink: (value) => void this.openWikilink(value),
        }),
        this.theme.of(editorTheme(this.settings.dark(), (BASE_FONT_PX * this.settings.zoom()) / 100)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !this.loading && this.session === session) {
            session.saver.change(update.state.doc.toString());
          }
        }),
      ],
    });
    if (this.view) this.view.setState(state);
    else this.view = new EditorView({ state, parent: host });
    this.loading = false;

    const line = this.editor.startLine();
    this.editor.startLine.set(null);
    if (line !== null) this.scrollToLine(line);
    this.view.focus();
  }

  private async write(session: Session, text: string): Promise<void> {
    const out = session.crlf ? toCrlf(text) : text;
    session.tracker.willWrite(out);
    try {
      await this.doc.write(session.path, out);
      session.tracker.written(out);
    } catch (error) {
      session.tracker.failed(out);
      throw error;
    }
  }

  /**
   * Before the note is left or the window closes: write pending changes. While an external change
   * is unresolved the note itself must not be overwritten, so the text goes to a copy next to it.
   */
  private async settle(): Promise<void> {
    const session = this.session;
    const pending = session?.saver.pendingText ?? null;
    if (!session || this.conflict() === null || pending === null) return this.flush();
    const copy = session.path.replace(/(\.[^./]+)?$/, ` (unsaved copy ${new Date().toISOString().replace(/[:.]/g, "-")}).md`);
    try {
      await backend.writeTextFile(copy, session.crlf ? toCrlf(pending) : pending);
      session.saver.discard();
      this.error.emit(`The note changed on disk; your edits were saved to ${copy}`);
    } catch (error) {
      this.error.emit(`Your edits could not be saved: ${String(error)}`);
    }
  }

  private flush(): Promise<void> {
    return this.session?.saver.flush() ?? Promise.resolve();
  }

  private topLine(): number {
    const view = this.view;
    if (!view) return 1;
    const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    return view.state.doc.lineAt(block.from).number;
  }

  private scrollToLine(line: number): void {
    const view = this.view;
    if (!view) return;
    const pos = view.state.doc.line(clampLine(line, view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
  }

  /** The watcher reported a change of the note; `diskText` is what is on disk now. */
  private onExternal(path: string, diskText: string): void {
    const session = this.session;
    if (!session || session.path !== path) return;
    switch (session.tracker.classify(diskText, session.saver.dirty)) {
      case "ignore":
        return;
      case "reload":
        void this.reloadIfUtf8(session, diskText);
        return;
      case "conflict":
        session.saver.hold(true);
        this.conflict.set(diskText);
    }
  }

  /** Loading lossy text would let the next save destroy the original bytes. */
  private async reloadIfUtf8(session: Session, text: string): Promise<boolean> {
    if (await backend.isUtf8File(session.path)) {
      if (this.session === session) this.replaceText(session, text);
      return true;
    }
    this.error.emit("The note is no longer valid UTF-8; editing stopped.");
    session.saver.discard();
    this.editor.editing.set(false);
    return false;
  }

  protected async reloadFromDisk(): Promise<void> {
    const session = this.session;
    const disk = this.conflict();
    if (!session || disk === null) return;
    if (!(await backend.isUtf8File(session.path))) {
      this.error.emit("The note on disk is not valid UTF-8; keep yours or fix the file first.");
      return;
    }
    session.saver.discard();
    this.replaceText(session, disk);
    this.conflict.set(null);
    session.saver.hold(false);
  }

  protected keepMine(): void {
    const session = this.session;
    if (!session) return;
    this.conflict.set(null);
    session.saver.hold(false);
    void session.saver.flush();
  }

  /** Puts the disk text into the editor as one undoable change that is not saved again. */
  private replaceText(session: Session, text: string): void {
    const view = this.view;
    if (!view) return;
    session.tracker.accept(text);
    this.loading = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    this.loading = false;
    if (this.doc.path() === session.path) this.doc.content.set(text);
  }

  private async openWikilink(value: string): Promise<void> {
    const { note, heading } = parseWikilinkTarget(value);
    const root = this.workspace.vaultRoot();
    const files = this.workspace.vaultFiles();
    const resolved = note && root && files ? resolveWikilink(value, files) : null;
    if (!root || !files || !note) return;
    if (!resolved) {
      await this.settle();
      await this.ops.createNoteForLink(value).catch((err) => this.error.emit(String(err)));
      return;
    }
    const path = joinPath(root, resolved);
    if (!isMarkdownPath(path)) return;
    await this.settle();
    await this.doc.open(path, { anchor: heading }).catch((err) => this.error.emit(String(err)));
  }
}
