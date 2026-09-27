import type { MarkdownIt, Token } from "markdown-it";

const TOC_RE = /^\[\[_TOC_\]\]$/i;

/**
 * Azure DevOps `[[_TOC_]]` marker: replaced by a nested list of links to all
 * headings of the document. Heading ids are set by markdown-it-anchor, which
 * runs as a core rule before rendering.
 */
export function adoTocPlugin(md: MarkdownIt): void {
  md.block.ruler.before("paragraph", "ado_toc", (state, startLine, _endLine, silent) => {
    const text = state.src
      .slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine])
      .trim();
    if (!TOC_RE.test(text)) return false;
    if (silent) return true;
    const token = state.push("ado_toc", "nav", 0);
    token.map = [startLine, startLine + 1];
    state.line = startLine + 1;
    return true;
  });

  md.renderer.rules["ado_toc"] = (tokens) => renderToc(md, tokens);
}

function renderToc(md: MarkdownIt, tokens: Token[]): string {
  const headings: { level: number; id: string; text: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "heading_open") continue;
    const id = t.attrGet("id");
    const inline = tokens[i + 1];
    if (!id || !inline) continue;
    const text = (inline.children ?? [])
      .filter((c) => c.type === "text" || c.type === "code_inline")
      .map((c) => c.content)
      .join("");
    headings.push({ level: Number(t.tag.slice(1)), id: String(id), text });
  }
  if (!headings.length) return "";

  const base = Math.min(...headings.map((h) => h.level));
  let html = '<nav class="toc">\n';
  let depth = 0;
  for (const h of headings) {
    const target = h.level - base + 1;
    if (target > depth) {
      while (depth < target) {
        html += "<ul>\n<li>";
        depth++;
      }
    } else {
      html += "</li>\n";
      while (depth > target) {
        html += "</ul>\n</li>\n";
        depth--;
      }
      html += "<li>";
    }
    html += `<a href="#${md.utils.escapeHtml(h.id)}">${md.utils.escapeHtml(h.text)}</a>`;
  }
  while (depth > 0) {
    html += "</li>\n</ul>\n";
    depth--;
  }
  return html + "</nav>\n";
}
