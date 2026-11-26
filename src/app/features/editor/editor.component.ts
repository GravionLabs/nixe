import type { ElementRef, OnDestroy } from "@angular/core";
import {
  ApplicationRef,
  Component,
  EnvironmentInjector,
  Injector,
  computed,
  createComponent,
  effect,
  inject,
  output,
  signal,
  untracked,
  viewChild,
} from "@angular/core";
import type { Extension } from "@codemirror/state";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HxMessageService } from "@gravionlabs/helix-ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";

import { countText } from "../../core/editor/text-stats";
import { editAndSave } from "../../core/editor/buffer-edit";
import {
  AutoSaver,
  ExternalChangeTracker,
  UNDO_RELOAD_MS,
  changedRange,
  clampLine,
  discardedByReload,
  toCrlf,
} from "../../core/editor/editor-core";
import { blocksOf, headingsOf } from "../../core/editor/completion-core";
import { LinkPreviewService } from "../../core/preview/link-preview.service";
import { targetOf } from "../../core/preview/preview-core";
import { OutlineService } from "../../core/outline/outline.service";
import { EditorService } from "../../core/editor/editor.service";
import { backend } from "../../core/file/backend";
import type { EditorLink } from "../../core/editor/editor-core";
import { classifyHref, resolveLocalLink } from "../../core/markdown/link-resolver";
import { DocumentService } from "../../core/file/document.service";
import { embedFor, pastedImageName } from "../../core/editor/attachment-core";
import { MarkdownService } from "../../core/markdown/markdown.service";
import { MermaidRenderer } from "../../core/markdown/mermaid-renderer";
import { insertTemplate } from "../../core/templates/template-core";
import { isEpubPath, isMarkdownPath, isRemoteEpubUrl, joinPath } from "../../core/markdown/paths";
import { WorkspacesService } from "../../core/workspace/workspaces.service";
import { parseWikilinkTarget, resolveWikilink } from "../../core/markdown/wikilink-resolver";
import { fileLabel } from "../../core/switcher/fuzzy";
import { SettingsService } from "../../core/settings/settings.service";
import { VaultOpsService } from "../../core/workspace/vault-ops.service";
import { TabsService } from "../../core/tabs/tabs.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import type { CompletionData } from "./completion";
import { FoldStateService } from "../../core/fold/fold-state.service";
import { editorBehavior, editorTheme } from "./editor-extensions";
import { textChange } from "./text-change";
import { BaseBlocks } from "../bases/base-blocks";
import { PropertiesComponent } from "../properties/properties.component";
import { ExternalCompareComponent } from "./external-compare.component";
import type { LivePreviewHooks, PropertiesHandle } from "./live-preview";
import { isRenderedLine, livePreview } from "./live-preview";
import { mountLiveBase } from "./live-bases";
import type { FoldAction } from "./folding";
import { foldAction, folding, restoreFolds } from "./folding";
import { headingLineAt } from "../../core/composer/composer-core";

/** The note being edited: its saver, its view of the disk and the folder a write may reach. */
interface Session {
  path: string;
  /** The note had CRLF line endings; CodeMirror normalizes them, so they are restored on save. */
  crlf: boolean;
  saver: AutoSaver;
  tracker: ExternalChangeTracker;
  /** Why the last write failed; null after one that worked. */
  failure: string | null;
  /** The disk text the next write expects (an edit from outside the editor); null: none. */
  expected: string | null;
}

/** Pause after the last change before the counts are recomputed. */
const STATS_DELAY_MS = 150;

/** CodeMirror 6 editor of the open note. Lives in its own lazy chunk (loaded by `@defer`). */
@Component({
  selector: "app-editor",
  templateUrl: "./editor.component.html",
  styleUrl: "./editor.component.css",
  imports: [ExternalCompareComponent],
})
export class EditorComponent implements OnDestroy {
  readonly failed = output<string>();

  private readonly doc = inject(DocumentService);
  private readonly tabs = inject(TabsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly ops = inject(VaultOpsService);
  private readonly workspaces = inject(WorkspacesService);
  private readonly preview = inject(LinkPreviewService);
  private readonly settings = inject(SettingsService);
  private readonly editor = inject(EditorService);
  private readonly outline = inject(OutlineService);
  private readonly folds = inject(FoldStateService);
  private readonly messages = inject(HxMessageService);
  private readonly appRef = inject(ApplicationRef);
  private readonly injector = inject(EnvironmentInjector);
  private readonly host = viewChild.required<ElementRef<HTMLElement>>("host");

  /** The disk text that conflicts with unsaved changes; null when there is no conflict. */
  protected readonly conflict = signal<string | null>(null);

  /** The editor text shown in the compare dialog; null while the dialog is closed. */
  protected readonly comparing = signal<string | null>(null);

  /** The toast that offers to undo the last reload from the bar. */
  private undoToast: number | null = null;

  private readonly theme = new Compartment();
  /** Holds the live preview; empty in source mode. */
  private readonly live = new Compartment();
  private readonly markdown = inject(MarkdownService);
  private readonly mermaid = new MermaidRenderer();
  /** The bases of the live preview. */
  private readonly bases = new BaseBlocks(this.appRef, this.injector, inject(Injector));
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
      applyText: (text) => this.applyText(text),
      holdsNote: () => this.holdsNote(),
      editText: (change) => this.editText(change),
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

    // The live preview and the plain source mode (Mod+E) swap without reloading the note.
    // Hiding the properties changes the decorations; folding them is the block's own business.
    const propertiesHidden = computed(() => this.settings.propertiesDisplay() === "hidden");
    effect(() => {
      const source = this.editor.source();
      propertiesHidden();
      untracked(() =>
        this.view?.dispatch({ effects: this.live.reconfigure(this.liveMode(source)) }),
      );
    });

    effect(() => {
      const dark = this.settings.dark();
      const zoom = this.settings.zoom();
      this.view?.dispatch({ effects: this.theme.reconfigure(editorTheme(dark, zoom)) });
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
    this.dropUndo();
    this.editor.settling = this.settle();
    this.editor.handle = null;
    this.outline.editorText.set(null);
    this.outline.topLine.set(null);
    this.editor.blocked.set(false);
    this.doc.editorHook = null;
    this.doc.remoteHook = null;
    this.view?.destroy();
    this.bases.dispose();
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
    this.comparing.set(null);
    this.dropUndo();
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
      failure: null,
      expected: null,
      saver: new AutoSaver({
        write: (t) => this.write(session, t),
        onError: (e) => this.failed.emit(`Saving failed: ${String(e)}`),
        onDirtyChange: (dirty) => this.editor.unsaved.set(dirty),
      }),
    };
    this.session = session;
    this.editor.unsaved.set(false);
    // Also for a note without a base, which drops the chosen views of the one before.
    this.bases.enter(current);

    this.loading = true;
    const state = EditorState.create({
      doc: text,
      extensions: [
        editorBehavior({
          onSave: () => void this.flush(),
          onBlur: () => void this.flush(),
          onLink: (link, newTab) => void this.openLink(link, newTab),
          opensOnPlainClick: (state, pos) => !this.editor.source() && isRenderedLine(state, pos),
          onWikilinkHover: (hover) =>
            hover
              ? this.preview.hover(targetOf(hover.value), hover.anchor, hover.modifier)
              : this.preview.leave(),
          completion: this.completionData,
        }),
        folding((lines) => {
          if (this.session === session && !this.restoringFolds) this.folds.set(session.path, lines);
        }),
        this.live.of(this.liveMode(this.editor.source())),
        this.theme.of(editorTheme(this.settings.dark(), this.settings.zoom())),
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

  /** A change from outside the text (the properties panel): one undoable transaction. */
  private applyText(next: string): void {
    const view = this.view;
    if (!view) return;
    const change = textChange(view.state.doc.toString(), next);
    if (change) view.dispatch({ changes: change });
  }

  private holdsNote(): boolean {
    return !!this.view && this.session !== null && this.session.path === this.doc.path();
  }

  /** An edit from outside the editor (a cell of a base), saved at once. */
  private async editText(change: (text: string) => string): Promise<void> {
    const session = this.session;
    const view = this.view;
    const closed = "The note was closed while it was changed.";
    if (!session || !view) throw new Error(closed);
    await editAndSave(
      {
        saver: session.saver,
        tracker: session.tracker,
        text: () => view.state.doc.toString(),
        apply: (text) => this.applyText(text),
        readDisk: () => backend.readTextFile(session.path),
        expectDisk: (disk) => (session.expected = disk),
        external: (disk) => this.onExternal(session.path, disk),
        refusal: () => {
          if (this.session !== session || this.destroyed) return closed;
          if (this.conflict() !== null)
            return "The note changed on disk: choose Reload or Keep mine first.";
          return this.doc.missing() ? "The file of the note was not found." : null;
        },
        failure: () => session.failure,
        clearFailure: () => (session.failure = null),
      },
      change,
    );
  }

  private liveMode(source: boolean): Extension {
    return source ? [] : livePreview(this.liveHooks);
  }

  /** Blocks of the live preview go through the same pipeline as the reading view. */
  private readonly liveHooks: LivePreviewHooks = {
    propertiesDisplay: () => this.settings.propertiesDisplay(),
    openLink: (link, newTab) => void this.openLink(link, newTab),
    mountProperties: (el, source, actions): PropertiesHandle => {
      const ref = createComponent(PropertiesComponent, {
        environmentInjector: this.injector,
        hostElement: el,
      });
      ref.setInput("sourceText", source);
      ref.instance.edited.subscribe((next) => actions.edit(next));
      ref.instance.editSource.subscribe(() => actions.showSource());
      ref.instance.failed.subscribe((message) => this.failed.emit(message));
      this.appRef.attachView(ref.hostView);
      ref.changeDetectorRef.detectChanges();
      return {
        update: (text) => {
          ref.setInput("sourceText", text);
          ref.changeDetectorRef.detectChanges();
        },
        destroy: () => {
          this.appRef.detachView(ref.hostView);
          ref.destroy();
        },
      };
    },
    mountBase: (el, origin, occurrence) =>
      mountLiveBase(this.bases, el, origin, occurrence, this.session?.path ?? null, () =>
        this.view?.requestMeasure(),
      ),
    render: (el, source) => {
      const ctx = {
        filePath: this.doc.path(),
        wikiRoot: this.doc.wikiRoot(),
        math: this.settings.math(),
        vaultFiles: this.workspace.vaultFiles(),
        vaultRoot: this.workspace.vaultRoot(),
      };
      el.classList.add("markdown-body");
      el.innerHTML = this.markdown.render(source, ctx); // sanitized by DOMPurify
      void this.markdown
        .expandEmbeds(el, ctx)
        .catch(() => undefined)
        .then(() => this.mermaid.render(el, this.settings.dark()))
        .then(() => this.view?.requestMeasure());
    },
  };

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
    const expected = session.expected ?? undefined;
    session.expected = null;
    session.tracker.willWrite(out);
    try {
      await this.doc.write(session.path, out, expected);
      session.tracker.written(out);
      session.failure = null;
    } catch (error) {
      session.tracker.failed(out);
      session.failure = String(error);
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
    const discarded = this.view?.state.doc.toString() ?? "";
    session.saver.discard();
    this.replaceText(session, disk);
    this.conflict.set(null);
    this.comparing.set(null);
    session.saver.hold(this.doc.missing());
    this.offerUndo(session, discarded);
  }

  /** Reload discards the unsaved edits: a toast puts them back for a while. */
  private offerUndo(session: Session, before: string): void {
    this.dropUndo();
    const discarded = discardedByReload(before, this.view?.state.doc.toString() ?? "");
    if (discarded === null) return;
    this.undoToast = this.messages.add({
      severity: "info",
      summary: "Reloaded from disk; your unsaved edits were discarded.",
      life: UNDO_RELOAD_MS,
      action: { label: "Undo", run: () => this.undoReload(session, discarded) },
    });
  }

  private dropUndo(): void {
    if (this.undoToast !== null) this.messages.remove(this.undoToast);
    this.undoToast = null;
  }

  /** Puts the discarded text back as an ordinary edit, so it is saved over the disk version. */
  private undoReload(session: Session, discarded: string): void {
    this.undoToast = null;
    const view = this.view;
    if (!view || this.session !== session || this.conflict() !== null) return;
    const range = changedRange(view.state.doc.toString(), discarded);
    if (range) view.dispatch({ changes: range, userEvent: "input.undo-reload" });
  }

  protected compare(): void {
    if (this.conflict() === null || !this.view) return;
    this.comparing.set(this.view.state.doc.toString());
  }

  protected closeCompare(): void {
    this.comparing.set(null);
    this.view?.focus();
  }

  protected chooseReload(): void {
    this.comparing.set(null);
    void this.reloadFromDisk();
  }

  protected chooseKeep(): void {
    this.comparing.set(null);
    this.keepMine();
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

  /** The one resolver of the editor: wikilink, Markdown link to a vault file, external URL. */
  private async openLink(link: EditorLink, newTab: boolean): Promise<void> {
    try {
      if (link.kind === "wikilink") {
        await this.openWikilink(link.target, newTab);
        return;
      }
      const href = classifyHref(link.target);
      switch (href.kind) {
        case "external":
          if (isRemoteEpubUrl(href.url)) await this.openBook(href.url);
          else await openUrl(href.url);
          break;
        case "local": {
          const current = this.session?.path;
          if (!current) return;
          const resolved = await resolveLocalLink(href.path, {
            currentFile: current,
            wikiRoot: this.doc.wikiRoot() ?? current,
            exists: backend.isFile,
          });
          if (!resolved) this.failed.emit(`File not found: ${href.path}`);
          else if (isMarkdownPath(resolved)) await this.openAt(resolved, href.anchor, newTab);
          else if (isEpubPath(resolved)) await this.openBook(resolved);
          else await openPath(resolved);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.failed.emit(String(err));
    }
  }

  private async openAt(path: string, anchor: string | null, newTab: boolean): Promise<void> {
    await this.settle();
    if (newTab) await this.tabs.openInNewTab(path, { anchor });
    else await this.tabs.openPreview(path, { anchor });
  }

  private async openBook(path: string): Promise<void> {
    await this.settle();
    await this.tabs.openEpub(path);
  }

  private async openWikilink(value: string, newTab: boolean): Promise<void> {
    const { note, heading } = parseWikilinkTarget(value);
    const other = note
      ? await this.workspaces.resolveLink(value, this.session?.path ?? null)
      : undefined;
    if (other) {
      if (isEpubPath(other)) await this.openBook(other);
      else await this.openAt(other, heading, newTab);
      return;
    }
    if (note && isEpubPath(note) && other === null) {
      this.failed.emit(`File not found: ${note}`);
      return;
    }
    const root = this.workspace.vaultRoot();
    const files = this.workspace.vaultFiles();
    const resolved = note && root && files ? resolveWikilink(value, files) : null;
    if (!root || !files || !note) return;
    if (!resolved && isEpubPath(note)) {
      this.failed.emit(`File not found: ${note}`);
      return;
    }
    if (!resolved) {
      await this.settle();
      await this.ops.createNoteForLink(value).catch((err) => this.failed.emit(String(err)));
      return;
    }
    const path = joinPath(root, resolved);
    if (isEpubPath(path)) {
      await this.openBook(path);
      return;
    }
    if (!isMarkdownPath(path)) return;
    await this.openAt(path, heading, newTab);
  }
}

/** A sibling of `path` for text that must not overwrite the note. */
function unsavedCopyPath(path: string): string {
  return path.replace(
    /(\.[^./]+)?$/,
    ` (unsaved copy ${new Date().toISOString().replace(/[:.]/g, "-")}).md`,
  );
}
