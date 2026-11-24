import { Injectable, inject, signal } from "@angular/core";

import { backend } from "../file/backend";
import { basename } from "../markdown/paths";
import { WorkspaceService } from "../workspace/workspace.service";
import type { EpubBook, EpubFlow } from "./epub";
import { bookTitle } from "./epub";

const FLOW_KEY = "nixe.epub-flow";

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

  setFlow(flow: EpubFlow): void {
    this.flow.set(flow);
    try {
      localStorage.setItem(FLOW_KEY, flow);
    } catch {
      // The choice is then kept for this session only.
    }
  }
}
