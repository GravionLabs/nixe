import type { MarkdownIt, StateBlock } from "markdown-it";

const OPEN_RE = /^:::\s*mermaid\s*$/i;
const CLOSE_RE = /^:::\s*$/;

/**
 * Azure DevOps Wiki mermaid syntax:
 *
 *     ::: mermaid
 *      graph LR;
 *      A --> B;
 *     :::
 *
 * Emitted as a regular fence token with info "mermaid" so that
 * mermaidFencePlugin renders both syntaxes identically.
 */
export function adoMermaidPlugin(md: MarkdownIt): void {
  md.block.ruler.before("fence", "ado_mermaid", adoMermaidRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

function adoMermaidRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (!OPEN_RE.test(lineText(state, startLine).trim())) return false;
  if (silent) return true;

  let nextLine = startLine + 1;
  let closed = false;
  for (; nextLine < endLine; nextLine++) {
    if (CLOSE_RE.test(lineText(state, nextLine).trim())) {
      closed = true;
      break;
    }
  }

  const raw = state.getLines(startLine + 1, nextLine, 0, true);

  const token = state.push("fence", "code", 0);
  token.info = "mermaid";
  token.markup = ":::";
  token.content = dedent(raw);
  token.map = [startLine, closed ? nextLine + 1 : nextLine];

  state.line = closed ? nextLine + 1 : nextLine;
  return true;
}

/** Removes the common leading indentation (ADO content is usually indented). */
export function dedent(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const indents = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => l.match(/^[ \t]*/)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n") + "\n";
}
