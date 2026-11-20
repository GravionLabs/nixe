import type { ElementRef, OnDestroy } from "@angular/core";
import { Component, effect, inject, output, signal, untracked, viewChild } from "@angular/core";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { countText } from "../../core/editor/text-stats";
import {
  AutoSaver,
  ExternalChangeTracker,
  changedRange,
  clampLine,
  toCrlf,
} from "../../core/editor/editor-core";
import { blocksOf, headingsOf } from "../../core/editor/completion-core";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { targetOf } from "../../core/preview/preview-core";
import { OutlineService } from "../../core/outline/outline.service";
import { EditorService } from "../../core/editor/editor.service";
import { backend } from "../../core/file/backend";
import { DocumentService } from "../../core/file/document.service";
import { embedFor, pastedImageName } from "../../core/editor/attachment-core";
import { insertTemplate } from "../../core/templates/template-core";
import { isMarkdownPath, joinPath } from "../../core/markdown/paths";
import { parseWikilinkTarget, resolveWikilink } from "../../core/markdown/wikilink-resolver";
import { fileLabel } from "../../core/switcher/fuzzy";
import { SettingsService } from "../../core/settings/settings.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import type { CompletionData } from "./completion";
import { FoldStateService } from "../../core/fold/fold-state.service";
import { editorBehavior, editorTheme } from "./editor-extensions";
import type { FoldAction } from "./folding";
import { foldAction, folding, restoreFolds } from "./folding";
import { headingLineAt } from "../../core/composer/composer-core";

const BASE_FONT_PX = 16;

/** The note being edited: its saver, its view of the disk and the folder a write may reach. */
interface Session {
  path: string;
  /** The note had CRLF line endings; CodeMirror normalizes them, so they are restored on save. */
  crlf: boolean;
  saver: AutoSaver;
  tracker: ExternalChangeTracker;
}

/** Pause after the last change before the counts are recomputed. */
const STATS_DELAY_MS = 150;

/** CodeMirror 6 editor of the open note. Lives in its own lazy chunk (loaded by `@defer`). */
@Component({
  selector: "app-editor",
  templateUrl: "./editor.component.html",
  styleUrl: "./editor.component.css",
})
export class EditorComponent implements OnDestroy {
  readonly failed = output<string>();

  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly ops = inject(VaultOpsService);
  private readonly preview = inject(LinkPreviewService);
  private readonly settings = inject(SettingsService);
  private readonly editor = inject(EditorService);
  private readonly outline = inject(OutlineService);
  private readonly folds = inject(FoldStateService);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>("host");

  /** The disk text that conflicts with unsaved changes; null when there is no conflict. */
  protected readonly conflict = signal<string | null>(null);

  private readonly theme = new Compartment();
  private view: EditorView | undefined;
  private session: Session | null = null;
  private loading = false;
  private unlistenClose: (() => void) | undefined;
  private destroyed = false;
  private statsTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.editor.handle = {
      topLine: () => this.topLine(),
      scrollToLine: (line) => this.scrollToLine(line),
      flush: () => this.flush(),
      dirty: () => this.session?.saver.dirty ?? false,
      blocked: () => this.conflict() !== null,
      saveCopy: () => this.saveCopy(),
      insertTemplate: (template) => this.insertTemplate(template),
      attachPaths: (paths) => this.attachPaths(paths),
      fold: (action) => this.fold(action),
      selection: () => this.selection(),
      headingLine: () => this.headingLine(),
    };
    this.doc.editorHook = (path, text) => this.onExternal(path, text);
    this.doc.remoteHook = (text, saved) => this.onRemote(text, saved);

    effect(() => this.editor.blocked.set(this.conflict() !== null));

    // A missing file must not be written back by the autosave: the text stays in the editor.
    effect(() => {
      const missing = this.doc.missing();
      untracked(() => this.session?.saver.hold(missing || this.conflict() !== null));
    });

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

  /** Counts after typing pauses, so a long note is not scanned on every key. */
  private scheduleStats(): void {
    clearTimeout(this.statsTimer);
    this.statsTimer = setTimeout(() => this.updateStats(), STATS_DELAY_MS);
  }

  private updateStats(): void {
    const view = this.view;
    if (!view || this.destroyed) return;
    const { from, to } = view.state.selection.main;
    this.editor.stats.set(
      from === to
        ? countText(view.state.doc.toString())
        : countText(view.state.sliceDoc(from, to), true),
    );
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    clearTimeout(this.statsTimer);
    this.editor.stats.set(null);
    this.unlistenClose?.();
    void this.settle();
    this.editor.handle = null;
    this.outline.editorText.set(null);
    this.outline.topLine.set(null);
    this.editor.blocked.set(false);
    this.doc.editorHook = null;
    this.doc.remoteHook = null;
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
      this.failed.emit("This note is not valid UTF-8; editing it would damage it.");
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
        onError: (e) => this.failed.emit(`Saving failed: ${String(e)}`),
        onDirtyChange: (dirty) => this.editor.unsaved.set(dirty),
      }),
    };
    this.session = session;
    this.editor.unsaved.set(false);

    this.loading = true;
    const state = EditorState.create({
      doc: text,
      extensions: [
        editorBehavior({
          onSave: () => void this.flush(),
          onBlur: () => void this.flush(),
          onWikilink: (value) => void this.openWikilink(value),
          onWikilinkHover: (hover) =>
            hover
              ? this.preview.hover(targetOf(hover.value), hover.anchor, hover.modifier)
              : this.preview.leave(),
          completion: this.completionData,
        }),
        folding((lines) => {
          if (this.session === session && !this.restoringFolds) this.folds.set(session.path, lines);
        }),
        this.theme.of(
          editorTheme(this.settings.dark(), (BASE_FONT_PX * this.settings.zoom()) / 100),
        ),
        EditorView.domEventHandlers({
          paste: (event) => this.onPaste(event),
          scroll: () => this.outline.topLine.set(this.topLine()),
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && this.session === session) {
            this.outline.editorText.set(update.state.doc.toString());
          }
          if ((update.docChanged || update.selectionSet) && this.session === session)
            this.scheduleStats();
          if (update.docChanged && !this.loading && this.session === session) {
            const text = update.state.doc.toString();
            session.saver.change(text);
            this.doc.typed(session.path, text);
          }
        }),
      ],
    });
    if (this.view) this.view.setState(state);
    else this.view = new EditorView({ state, parent: host });
    this.loading = false;
    this.outline.editorText.set(text);
    this.updateStats();
    void this.restoreFolds(session);

    const line = this.editor.startLine();
    this.editor.startLine.set(null);
    if (line !== null) this.scrollToLine(line);
    this.outline.topLine.set(this.topLine());
    this.view.focus();
  }

  private restoringFolds = false;

  /** Closes the folds remembered for the note, unless the user already changed them meanwhile. */
  private async restoreFolds(session: Session): Promise<void> {
    const lines = await this.folds.linesOf(session.path);
    const view = this.view;
    if (!view || this.session !== session || lines.length === 0) return;
    this.restoringFolds = true;
    try {
      restoreFolds(view, lines);
    } finally {
      this.restoringFolds = false;
    }
  }

  private selection(): { start: number; end: number; text: string } | null {
    const view = this.view;
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    return from === to ? null : { start: from, end: to, text: view.state.sliceDoc(from, to) };
  }

  private headingLine(): number | null {
    const view = this.view;
    if (!view) return null;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    return headingLineAt(view.state.doc.toString(), line);
  }

  private fold(action: FoldAction): void {
    const view = this.view;
    if (!view) return;
    foldAction(view, action);
    view.focus();
  }

  /** What `[[` and `#` completion reads: the index for notes and tags, the note text for headings. */
  private readonly completionData: CompletionData = {
    notes: async () => {
      const notes = await backend.notes().catch(() => []);
      if (notes.length) return notes;
      return (this.workspace.vaultFiles() ?? [])
        .filter((p) => /\.md$/iu.test(p))
        .map((path) => ({ path, title: fileLabel(path), aliases: [] }));
    },
    currentPath: () => this.relativePath(this.doc.path()),
    linkFormat: () => backend.linkFormat().catch(() => "shortest" as const),
    headings: async (note, openText) => headingsOf(await this.textOf(note, openText)),
    blocks: async (note, openText) => blocksOf(await this.textOf(note, openText)),
    tags: () => backend.tags().catch(() => []),
  };

  private relativePath(path: string | null): string | null {
    const root = this.workspace.vaultRoot();
    return path && root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null;
  }

  /** The text of the note a link target names; the open note (as typed) for an empty target. */
  private async textOf(note: string, openText: string): Promise<string> {
    if (!note) return openText;
    const root = this.workspace.vaultRoot();
    const files = this.workspace.vaultFiles();
    const rel = root && files ? resolveWikilink(note, files) : null;
    if (!root || !rel || !isMarkdownPath(rel)) return "";
    return backend.readTextFile(joinPath(root, rel)).catch(() => "");
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
    const copy = unsavedCopyPath(session.path);
    try {
      await backend.writeTextFile(copy, session.crlf ? toCrlf(pending) : pending);
      session.saver.discard();
      this.failed.emit(`The note changed on disk; your edits were saved to ${copy}`);
    } catch (error) {
      this.failed.emit(`Your edits could not be saved: ${String(error)}`);
    }
  }

  /** "Save as copy" of a note whose file is gone: the editor text goes next to where it was. */
  private async saveCopy(): Promise<void> {
    const session = this.session;
    const view = this.view;
    if (!session || !view) return;
    const copy = unsavedCopyPath(session.path);
    try {
      const text = view.state.doc.toString();
      await backend.writeTextFile(copy, session.crlf ? toCrlf(text) : text);
      session.saver.discard();
      this.failed.emit(`Saved a copy to ${copy}`);
    } catch (error) {
      this.failed.emit(`The copy could not be saved: ${String(error)}`);
    }
  }

  private insertTemplate(template: string): void {
    const view = this.view;
    if (!view) throw new Error("Open the editor first.");
    const { changes, cursor } = insertTemplate(
      view.state.doc.toString(),
      view.state.selection.main.head,
      template,
    );
    view.dispatch({
      changes,
      selection: { anchor: cursor },
      scrollIntoView: true,
      userEvent: "input.paste",
    });
    view.focus();
  }

  /** A pasted image (or file) is copied into the vault; plain text pastes as usual. */
  private onPaste(event: ClipboardEvent): boolean {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0 || !this.session) return false;
    event.preventDefault();
    void this.attachFiles(files).catch((err) =>
      this.failed.emit(`Attaching failed: ${String(err)}`),
    );
    return true;
  }

  private async attachFiles(files: File[]): Promise<void> {
    const note = this.session?.path;
    if (!note) return;
    const saved: string[] = [];
    for (const file of files) {
      const name =
        file.type.startsWith("image/") && (!file.name || /^image\.\w+$/iu.test(file.name))
          ? pastedImageName(new Date(), file.type)
          : file.name || pastedImageName(new Date(), file.type);
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      saved.push(await backend.saveAttachment(note, name, bytes));
    }
    await this.insertEmbeds(saved);
  }

  private async attachPaths(paths: string[]): Promise<void> {
    const note = this.session?.path;
    if (!note) return;
    const saved: string[] = [];
    for (const source of paths) saved.push(await backend.importAttachment(note, source));
    await this.insertEmbeds(saved);
  }

  private async insertEmbeds(relativePaths: string[]): Promise<void> {
    const view = this.view;
    if (!view) return;
    await this.workspace.reloadTree().catch(() => undefined);
    const files = this.workspace.vaultFiles() ?? [];
    const text = relativePaths.map((p) => embedFor(p, files)).join("\n");
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
      userEvent: "input.paste",
    });
    view.focus();
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
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
    this.outline.topLine.set(this.topLine());
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

  /**
   * Another tab shows the same note: its typing is taken over as a change that is not saved again
   * (the tab that typed saves it); its save is an own write, not an external change.
   */
  private onRemote(text: string, saved: boolean): void {
    const session = this.session;
    const view = this.view;
    if (!session || !view) return;
    if (saved) {
      session.tracker.willWrite(text);
      session.tracker.written(text);
    }
    // Also for a save: the view may still lack what the other tab typed before it was opened.
    const range = changedRange(view.state.doc.toString(), text.replace(/\r\n/g, "\n"));
    if (!range) return;
    this.loading = true;
    view.dispatch({ changes: range });
    this.loading = false;
  }

  /** Loading lossy text would let the next save destroy the original bytes. */
  private async reloadIfUtf8(session: Session, text: string): Promise<boolean> {
    if (await backend.isUtf8File(session.path)) {
      if (this.session === session) this.replaceText(session, text);
      return true;
    }
    this.failed.emit("The note is no longer valid UTF-8; editing stopped.");
    session.saver.discard();
    this.editor.editing.set(false);
    return false;
  }

  protected async reloadFromDisk(): Promise<void> {
    const session = this.session;
    const disk = this.conflict();
    if (!session || disk === null) return;
    if (!(await backend.isUtf8File(session.path))) {
      this.failed.emit("The note on disk is not valid UTF-8; keep yours or fix the file first.");
      return;
    }
    session.saver.discard();
    this.replaceText(session, disk);
    this.conflict.set(null);
    session.saver.hold(this.doc.missing());
  }

  protected keepMine(): void {
    const session = this.session;
    if (!session) return;
    this.conflict.set(null);
    session.saver.hold(this.doc.missing());
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
      await this.ops.createNoteForLink(value).catch((err) => this.failed.emit(String(err)));
      return;
    }
    const path = joinPath(root, resolved);
    if (!isMarkdownPath(path)) return;
    await this.settle();
    await this.doc.open(path, { anchor: heading }).catch((err) => this.failed.emit(String(err)));
  }
}

/** A sibling of `path` for text that must not overwrite the note. */
function unsavedCopyPath(path: string): string {
  return path.replace(
    /(\.[^./]+)?$/,
    ` (unsaved copy ${new Date().toISOString().replace(/[:.]/g, "-")}).md`,
  );
}
