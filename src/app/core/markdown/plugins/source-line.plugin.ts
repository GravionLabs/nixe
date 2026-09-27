import type { MarkdownIt } from "markdown-it";

/**
 * Adds `data-line="<source line>"` to top-level block elements so the preview
 * can follow the editor's scroll position.
 */
export function sourceLinePlugin(md: MarkdownIt): void {
  md.core.ruler.push("source_line", (state) => {
    for (const token of state.tokens) {
      if (token.map && token.level === 0 && token.nesting !== -1) {
        token.attrSet("data-line", String(token.map[0]));
      }
    }
  });
}
