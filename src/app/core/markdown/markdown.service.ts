import { Injectable } from "@angular/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import type { MarkdownIt } from "markdown-it";

import { expandEmbeds } from "./embed-expander";
import { backend } from "../file/backend";
import { classifyHref } from "./link-resolver";
import { createMarkdownRenderer } from "./markdown-renderer";
import { renderNote, type RenderedNote } from "./note";
import { dirname, isAbsolutePath, joinPath } from "./paths";

export interface RenderContext {
  filePath: string | null;
  wikiRoot: string | null;
  math: boolean;
  /** Vault-relative files; enables `unresolved` marking of wikilinks. */
  vaultFiles?: readonly string[] | null;
  /** Absolute vault root; resolves embedded images and notes. */
  vaultRoot?: string | null;
  /** ```base fences and `.base` embeds become base blocks (reading view, export, preview). */
  bases?: boolean;
}

/** DOMPurify keeps the TeX source of a math block (`<annotation>`), which its copy button reads. */
export const SANITIZE = { ADD_TAGS: ["annotation"], ADD_ATTR: ["encoding"] };

/** Markdown → sanitized HTML, with local image paths mapped to Tauri's asset protocol. */
@Injectable({ providedIn: "root" })
export class MarkdownService {
  private readonly renderers = new Map<string, MarkdownIt>();
  /** Context of the render in progress, read by the (global) DOMPurify hook. */
  private current: RenderContext | null = null;

  constructor() {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "IMG") {
        const url = this.imageUrl(node.getAttribute("src"));
        if (url) node.setAttribute("src", url);
      }
    });
  }

  render(text: string, ctx: RenderContext): string {
    return this.renderNote(text, ctx).html;
  }

  /** Sanitized HTML plus the note's properties and collected tags. */
  renderNote(text: string, ctx: RenderContext): RenderedNote {
    const options = { math: ctx.math, bases: ctx.bases ?? false };
    const key = `${options.math} ${options.bases}`;
    let md = this.renderers.get(key);
    if (!md) {
      md = createMarkdownRenderer(options);
      this.renderers.set(key, md);
    }
    this.current = ctx;
    try {
      const note = renderNote(md, text, ctx.vaultFiles ?? undefined, ctx.vaultRoot ?? undefined);
      return {
        ...note,
        html: DOMPurify.sanitize(note.html, SANITIZE),
        body: DOMPurify.sanitize(note.body, SANITIZE),
      };
    } finally {
      this.current = null;
    }
  }

  /**
   * Fills the `![[Note]]` placeholders below `root`: each note is read through the read command,
   * rendered with the same pipeline (sanitized) and inserted. Cycles and depth > 3 get a placeholder.
   */
  async expandEmbeds(root: HTMLElement, ctx: RenderContext): Promise<void> {
    const { vaultRoot, vaultFiles } = ctx;
    if (!vaultRoot || !vaultFiles || !root.querySelector(".embed[data-embed]")) return;
    const prefix = vaultRoot.endsWith("/") ? vaultRoot : `${vaultRoot}/`;
    const current = ctx.filePath?.startsWith(prefix) ? ctx.filePath.slice(prefix.length) : "";
    await expandEmbeds(
      root,
      {
        vaultRoot,
        vaultFiles,
        read: (path) => backend.readTextFile(path),
        render: (text, path) => this.render(text, { ...ctx, filePath: path }),
      },
      [current],
    );
  }

  /**
   * Relative image paths resolve against the document's folder; paths starting
   * with "/" resolve against the wiki/repository root (as on GitHub and Azure
   * DevOps, e.g. "/.attachments/image.png").
   */
  private imageUrl(src: string | null): string | null {
    const target = classifyHref(src);
    if (target.kind !== "local" || !this.current) return null;

    let path: string;
    try {
      path = decodeURIComponent(target.path);
    } catch {
      path = target.path;
    }

    const { filePath, wikiRoot } = this.current;
    if (path.startsWith("/") && wikiRoot && !path.startsWith(wikiRoot)) {
      return convertFileSrc(joinPath(wikiRoot, path));
    }
    if (isAbsolutePath(path)) return convertFileSrc(path);
    return filePath ? convertFileSrc(joinPath(dirname(filePath), path)) : null;
  }
}
