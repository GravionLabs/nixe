import { Injectable, inject } from "@angular/core";
import { open, save } from "@tauri-apps/plugin-dialog";

import { backend, type ExportRequest, type FolderNote } from "../file/backend";
import { MarkdownService } from "../markdown/markdown.service";
import { MermaidRenderer } from "../markdown/mermaid-renderer";
import { SettingsService } from "../settings/settings.service";
import { DocumentService } from "../file/document.service";
import { WorkspaceService } from "../workspace/workspace.service";
import {
  buildHtmlDocument,
  collectContentCss,
  inlineFonts,
  inlineImages,
  noteTitle,
  plainWikilinks,
  sanitizePageSize,
  stripAppControls,
  type ExportFormat,
  type ExportOptions,
} from "./export-core";
import { fitTimelines } from "./timeline-core";

/** A note to export with what its rendering needs. */
export interface ExportSource {
  path: string;
  text: string;
  vaultRoot: string | null;
  vaultFiles: readonly string[] | null;
  wikiRoot: string | null;
}

/** A folder export with failed notes; the command line prints the message as it is. */
export class FolderExportError extends Error {
  override toString(): string {
    return this.message;
  }
}

/** Exports one note as a standalone HTML file, or prints it (PDF through "Save as PDF"). */
@Injectable({ providedIn: "root" })
export class ExportService {
  private readonly markdown = inject(MarkdownService);
  private readonly settings = inject(SettingsService);
  private readonly doc = inject(DocumentService);
  private readonly workspace = inject(WorkspaceService);
  private readonly mermaid = new MermaidRenderer();

  /** The export options the settings give. */
  options(): ExportOptions {
    return {
      dark: this.settings.exportDark(),
      pageSize: sanitizePageSize(this.settings.exportPageSize()),
      pageBreaks: this.settings.exportPageBreaks(),
    };
  }

  /** The open note, as HTML (asks for the file) or on paper (the print dialog). */
  async exportCurrent(format: ExportFormat | "print"): Promise<string | null> {
    const path = this.doc.path();
    if (!path) throw new Error("No note is open");
    const html = await this.build(
      {
        path,
        text: this.doc.content(),
        vaultRoot: this.workspace.vaultRoot(),
        vaultFiles: this.workspace.vaultFiles(),
        wikiRoot: this.doc.wikiRoot(),
      },
      this.options(),
    );
    if (format !== "html") {
      await printHtml(html);
      return null;
    }
    const target = await save({
      title: "Export as HTML",
      defaultPath: `${noteTitle(path)}.html`,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!target) return null;
    await backend.writeExportFile(target, html);
    return target;
  }

  /** A folder of the vault (ask for it, the vault by default) as a static website in a chosen folder. */
  async exportSite(): Promise<{ out: string; pages: number } | null> {
    const root = this.workspace.vaultRoot();
    if (!root) throw new Error("No vault is open");
    const folder = await open({ title: "Folder to publish", directory: true, defaultPath: root });
    if (typeof folder !== "string") return null;
    const out = await open({ title: "Write the site into", directory: true, defaultPath: root });
    if (typeof out !== "string") return null;
    return { out, pages: await backend.exportSite(folder, out) };
  }

  /**
   * `nixe export`: the note of the request, written to `out`. A PDF without `out` opens the print
   * dialog; with `out` the window shows the document and the web view prints it into the file.
   * A folder export reports its files note by note, so its answer is empty.
   */
  async runRequest(request: ExportRequest): Promise<string | null> {
    if (request.notes) {
      await this.runFolder(request, request.notes);
      return "";
    }
    const text = await backend.readTextFile(request.note);
    const options = this.requestOptions(request);
    const html = await this.build(
      {
        path: request.note,
        text,
        vaultRoot: request.vaultRoot,
        vaultFiles: await backend.listVaultFiles(request.vaultRoot),
        wikiRoot: null,
      },
      options,
    );
    if (request.format === "pdf" && !request.out) {
      await printHtml(html);
      return null;
    }
    if (!request.out) throw new Error("no output file");
    if (request.format === "pdf") {
      await showForPrint(html);
      await backend.printExportPdf(request.out, options.pageSize);
    } else {
      await backend.writeExportFile(request.out, html);
    }
    return request.out;
  }

  /**
   * `nixe export <folder> --format pdf`: prints the notes of the request one after the other in
   * this window and reports each. A note that fails does not stop the others; the folder fails
   * after the last one.
   */
  private async runFolder(request: ExportRequest, notes: readonly FolderNote[]): Promise<void> {
    const options = this.requestOptions(request);
    const vaultFiles = await backend.listVaultFiles(request.vaultRoot);
    /** The note that took each PDF: `A.md` and `A.markdown` would both write `A.pdf`. */
    const taken = new Map<string, string>();
    let failed = 0;
    for (const [i, item] of notes.entries()) {
      let error: string | null = null;
      try {
        const other = taken.get(item.out);
        if (other !== undefined) throw new Error(`${item.out} is already the PDF of ${other}`);
        taken.set(item.out, item.name);
        const html = await this.build(
          {
            path: item.note,
            text: await backend.readTextFile(item.note),
            vaultRoot: request.vaultRoot,
            vaultFiles,
            wikiRoot: null,
          },
          options,
        );
        // The next note is built with the styles of the app, so the app comes back after each.
        const restore = await showForPrint(html);
        try {
          await backend.printExportPdf(item.out, options.pageSize);
        } finally {
          restore();
        }
      } catch (err) {
        error = String(err);
        failed++;
      }
      await backend.reportExportNote({
        index: i + 1,
        total: notes.length,
        name: item.name,
        written: error === null ? item.out : null,
        error,
      });
    }
    if (failed) {
      throw new FolderExportError(`${failed} of ${notes.length} notes could not be exported`);
    }
  }

  /** The settings, with what the command line overrides. */
  private requestOptions(request: ExportRequest): ExportOptions {
    const base = this.options();
    return {
      ...base,
      dark: request.dark ?? base.dark,
      pageSize: request.pageSize ? sanitizePageSize(request.pageSize) : base.pageSize,
    };
  }

  /** The complete HTML document of a note. Embeds, diagrams, math and images are resolved. */
  async build(source: ExportSource, options: ExportOptions): Promise<string> {
    const ctx = {
      filePath: source.path,
      wikiRoot: source.wikiRoot,
      math: this.settings.math(),
      vaultFiles: source.vaultFiles,
      vaultRoot: source.vaultRoot,
    };
    const host = document.createElement("div");
    // Diagrams measure text, so the host sits in the document, out of sight.
    host.style.cssText = "position:fixed;left:-99999px;top:0;width:900px;visibility:hidden";
    document.body.append(host);
    try {
      host.innerHTML = this.markdown.renderNote(source.text, ctx).body; // sanitized by the service
      await this.markdown.expandEmbeds(host, ctx).catch(() => undefined);
      await this.mermaid.render(host, options.dark);
      fitTimelines(host, options.pageSize);
      plainWikilinks(host);
      stripAppControls(host);
      await inlineImages(host, (path) => backend.readDataUri(path));
      let css = collectContentCss(Array.from(document.styleSheets));
      if (host.querySelector(".katex")) {
        css = await inlineFonts(css, (url) =>
          backend.readBundledDataUri(new URL(url, document.baseURI).pathname),
        );
      } else {
        css = css.replace(/@font-face\s*\{[^}]*\}/gu, "");
      }
      return buildHtmlDocument({
        title: noteTitle(source.path),
        body: host.innerHTML,
        css,
        options,
      });
    } finally {
      host.remove();
    }
  }
}

/** Prints a complete document in a hidden frame, so the app around it stays out of the print. */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    const done = () => {
      frame.remove();
      resolve();
    };
    frame.addEventListener("load", () => {
      const win = frame.contentWindow;
      if (!win) return reject(new Error("cannot print"));
      win.addEventListener("afterprint", done);
      try {
        win.focus();
        win.print();
      } catch (err) {
        frame.remove();
        reject(err);
        return;
      }
      // Some webviews never report `afterprint`.
      setTimeout(done, 60_000);
    });
    frame.srcdoc = html;
    document.body.append(frame);
  });
}

/** Keeps the root attributes of the document `showForPrint` shows. */
let rootGuard: MutationObserver | null = null;

/**
 * Replaces the document of this window with a complete export document and resolves when its
 * images and fonts are loaded, so a print holds all of it. The app is gone from the window until
 * the returned function brings it back: only the window of a headless export may use it.
 */
export async function showForPrint(html: string): Promise<() => void> {
  const next = new DOMParser().parseFromString(html, "text/html");
  const root = document.documentElement;
  const attributesOf = (element: Element) =>
    new Map(Array.from(element.attributes, (a) => [a.name, a.value] as const));
  const appAttributes = attributesOf(root);
  let wanted = attributesOf(next.documentElement);
  // Writes only what differs, so the observer below does not answer itself.
  const setRootAttributes = () => {
    for (const name of root.getAttributeNames()) {
      if (!wanted.has(name)) root.removeAttribute(name);
    }
    for (const [name, value] of wanted) {
      if (root.getAttribute(name) !== value) root.setAttribute(name, value);
    }
  };
  setRootAttributes();
  // The theme of the app still runs and sets its own class on the root, at any time: the look of
  // the export wins as long as it is shown.
  // Only one at a time: two would answer each other without end.
  rootGuard?.disconnect();
  rootGuard = new MutationObserver(setRootAttributes);
  rootGuard.observe(root, { attributes: true });
  // The stylesheets of the app are switched off where they are: a `<link>` that is put back
  // would load again, too late for the next note. The rest of the head makes room.
  const sheets: CSSStyleSheet[] = [];
  const removed: Node[] = [];
  for (const node of Array.from(document.head.childNodes)) {
    const sheet =
      node instanceof HTMLStyleElement || node instanceof HTMLLinkElement ? node.sheet : null;
    if (sheet) {
      if (!sheet.disabled) sheets.push(sheet);
      sheet.disabled = true;
    } else {
      removed.push(node);
      node.remove();
    }
  }
  const adopt = (node: Node) => document.importNode(node, true);
  const added = Array.from(next.head.childNodes, adopt);
  document.head.append(...added);
  const appBody = document.body;
  const body = document.importNode(next.body, true);
  appBody.replaceWith(body);
  const restore = () => {
    rootGuard?.disconnect();
    rootGuard = null;
    wanted = appAttributes;
    setRootAttributes();
    for (const node of added) node.parentNode?.removeChild(node);
    document.head.prepend(...removed);
    for (const sheet of sheets) sheet.disabled = false;
    body.replaceWith(appBody);
  };

  // A hidden window loads no lazy image.
  const images = Array.from(body.querySelectorAll("img"));
  for (const img of images) img.loading = "eager";
  await Promise.all(
    images
      .filter((img) => !img.complete)
      // A broken image is complete too: it prints its alternative text.
      .map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
  );
  // Fonts load when the layout asks for them, which may be only at the print: ask for all now.
  if (document.fonts) {
    await Promise.allSettled(Array.from(document.fonts, (font) => font.load()));
    await document.fonts.ready;
  }
  return restore;
}
