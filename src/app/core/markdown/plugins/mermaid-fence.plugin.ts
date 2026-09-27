import type { MarkdownIt } from "markdown-it";

/**
 * Renders ```mermaid fences as `<pre class="mermaid">` placeholders.
 * The actual SVG rendering happens later in the browser (see mermaid-renderer.ts).
 * Other plugins (e.g. the Azure DevOps `::: mermaid` rule) emit regular fence
 * tokens with info "mermaid", so they are rendered here as well.
 */
export function mermaidFencePlugin(md: MarkdownIt): void {
  const fallback = md.renderer.rules["fence"]!;

  md.renderer.rules["fence"] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase();
    if (lang !== "mermaid") {
      return fallback(tokens, idx, options, env, self);
    }
    const line = token.map ? ` data-line="${token.map[0]}"` : "";
    return `<pre class="mermaid"${line}>${md.utils.escapeHtml(token.content)}</pre>\n`;
  };
}
