import MarkdownItCtor, { type MarkdownIt } from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import * as katexModule from "@vscode/markdown-it-katex";
import hljs from "highlight.js/lib/common";

import { adoMermaidPlugin } from "./plugins/ado-mermaid.plugin";
import { adoTocPlugin } from "./plugins/ado-toc.plugin";
import { mermaidFencePlugin } from "./plugins/mermaid-fence.plugin";
import { sourceLinePlugin } from "./plugins/source-line.plugin";

export interface RendererOptions {
  /** Enables LaTeX math via KaTeX (`$…$`, `$$…$$`, ```math fences). */
  math: boolean;
}

type MarkdownItPlugin = (md: MarkdownIt, options?: unknown) => void;

// The KaTeX plugin is CommonJS; depending on the bundler the plugin function
// is either the default export or nested one level deeper.
const katexPlugin: MarkdownItPlugin = ((katexModule as any).default?.default ??
  (katexModule as any).default ??
  katexModule) as MarkdownItPlugin;

/** GitHub/Azure-DevOps-style heading slugs: lowercase, punctuation removed, spaces → "-". */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Framework-free markdown-it setup. Output is NOT sanitized. */
export function createMarkdownRenderer(options: RendererOptions): MarkdownIt {
  const md: MarkdownIt = new MarkdownItCtor({
    html: true,
    linkify: true,
    typographer: false,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          // Returning only the inner HTML lets markdown-it wrap it in <pre><code>
          // including the data-line attribute used for scroll sync.
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
          // fall through to default rendering
        }
      }
      return "";
    },
  });

  md.use(anchor, { slugify, tabIndex: false })
    .use(footnote)
    .use(taskLists, { enabled: false, label: true })
    .use(adoMermaidPlugin)
    .use(mermaidFencePlugin)
    .use(adoTocPlugin)
    .use(sourceLinePlugin);

  if (options.math) {
    md.use(katexPlugin, { throwOnError: false, enableFencedBlocks: true });
  }
  return md;
}
