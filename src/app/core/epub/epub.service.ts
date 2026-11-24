import { Injectable, inject, signal } from "@angular/core";

import { backend } from "../file/backend";
import { basename, toSlashes } from "../markdown/paths";
import { WorkspaceService } from "../workspace/workspace.service";
import type { EpubBook, EpubFlow } from "./epub";
import { bookTitle, parsePosition, positionKey } from "./epub";

const FLOW_KEY = "nixe.epub-flow";
/** How long the position must rest before it is written. */
const SAVE_DELAY_MS = 1000;

function storedFlow(): EpubFlow {
  try {
    return localStorage.getItem(FLOW_KEY) === "scrolled" ? "scrolled" : "paginated";
  } catch {
    return "paginated";
  }
}

/** Reads a book through the Rust core and parses it with foliate-js (ADR 0009). */
@Injectable({ providedIn: "root" })
export class EpubService {
  private readonly workspace = inject(WorkspaceService);

  /** How the reader lays the book out; kept for the next book and the next start. */
  readonly flow = signal<EpubFlow>(storedFlow());

  /** Reads and parses the book at `path`; fails with the message of the core or of the parser. */
  async load(path: string): Promise<EpubBook> {
    const roots = this.workspace
      .extraRoots()
      .map((node) => node.dirPath)
      .filter((dir): dir is string => dir !== null);
    const bytes = await backend.readEpub(path, roots);
    const name = basename(path);
    const file = new File([bytes as BlobPart], name, { type: "application/epub+zip" });
    const { makeBook } = await import("foliate-js/view.js");
    const book = await makeBook(file);
    return { path, title: bookTitle(book, name.replace(/\.epub$/i, "")), book };
  }

  /**
   * The root name and the path relative to it of the book: the vault of the window or a further
   * root (the core reads no book from anywhere else). The file is always kept in the vault of the
   * window, so a book of a further root is named by that root. `null` for any other path.
   */
  private locate(path: string): { root: string; rel: string } | null {
    const file = toSlashes(path);
    const roots: { name: string; dir: string }[] = [];
    const vault = this.workspace.vaultRoot();
    if (vault) roots.push({ name: basename(vault), dir: toSlashes(vault) });
    for (const node of this.workspace.extraRoots()) {
      if (node.dirPath) roots.push({ name: node.name, dir: toSlashes(node.dirPath) });
    }
    const hit = roots
      .filter((r) => file.startsWith(`${r.dir.replace(/\/$/, "")}/`))
      .sort((a, b) => b.dir.length - a.dir.length)[0];
    return hit ? { root: hit.name, rel: file.slice(hit.dir.replace(/\/$/, "").length + 1) } : null;
  }

  /** The saved CFI of the book at `path`; nothing saved, a damaged file or a failure gives `null`. */
  async position(path: string): Promise<string | null> {
    const at = this.locate(path);
    if (!at) return null;
    try {
      return parsePosition(
        await backend.readEpubPosition(positionKey(at.root, at.rel)),
        at.root,
        at.rel,
      );
    } catch {
      return null;
    }
  }

  private readonly pending = new Map<
    string,
    { cfi: string; timer: ReturnType<typeof setTimeout> }
  >();

  /**
   * Remembers the position of the book at `path`: written once it has rested for a second, never
   * waited for. A failed write is not reported; the next position change writes again.
   */
  savePosition(path: string, cfi: string): void {
    const old = this.pending.get(path);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => this.flushPosition(path), SAVE_DELAY_MS);
    this.pending.set(path, { cfi, timer });
  }

  /** Writes the position of `path` at once when one waits (the tab closes, the window ends). */
  flushPosition(path: string): void {
    const entry = this.pending.get(path);
    const at = this.locate(path);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(path);
    if (!at) return;
    const content = JSON.stringify({ root: at.root, path: at.rel, cfi: entry.cfi });
    backend.writeEpubPosition(positionKey(at.root, at.rel), content).catch(() => undefined);
  }

  setFlow(flow: EpubFlow): void {
    this.flow.set(flow);
    try {
      localStorage.setItem(FLOW_KEY, flow);
    } catch {
      // The choice is then kept for this session only.
    }
  }
}
