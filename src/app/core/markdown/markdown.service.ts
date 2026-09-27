import { Injectable } from "@angular/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import type { MarkdownIt } from "markdown-it";

import { classifyHref } from "./link-resolver";
import { createMarkdownRenderer } from "./markdown-renderer";
import { dirname, isAbsolutePath, joinPath } from "./paths";

export interface RenderContext {
  filePath: string | null;
  wikiRoot: string | null;
  math: boolean;
}

/** Markdown → sanitized HTML, with local image paths mapped to Tauri's asset protocol. */
@Injectable({ providedIn: "root" })
export class MarkdownService {
  private readonly renderers = new Map<boolean, MarkdownIt>();
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
    let md = this.renderers.get(ctx.math);
    if (!md) {
      md = createMarkdownRenderer({ math: ctx.math });
      this.renderers.set(ctx.math, md);
    }
    this.current = ctx;
    try {
      return DOMPurify.sanitize(md.render(text));
    } finally {
      this.current = null;
    }
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
