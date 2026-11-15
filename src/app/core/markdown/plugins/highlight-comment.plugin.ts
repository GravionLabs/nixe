import type { MarkdownIt } from "markdown-it";

const EQUALS = 0x3d;
const PERCENT = 0x25;

/** `==text==` → `<mark>`. The text may not start or end with whitespace. */
export function highlightPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("emphasis", "highlight", (state, silent) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== EQUALS || src.charCodeAt(start + 1) !== EQUALS) return false;
    const end = src.indexOf("==", start + 2);
    if (end < 0) return false;
    const content = src.slice(start + 2, end);
    if (!content || /^\s|\s$/.test(content)) return false;
    if (!silent) {
      state.push("mark_open", "mark", 1);
      const max = state.posMax;
      state.pos = start + 2;
      state.posMax = end;
      state.md.inline.tokenize(state);
      state.pos = end + 2;
      state.posMax = max;
      state.push("mark_close", "mark", -1);
    } else {
      state.pos = end + 2;
    }
    return true;
  });
}

/** Obsidian `%%comment%%`: inline within a paragraph, or as a block spanning several lines. Removed from output. */
export function commentPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("emphasis", "comment", (state, silent) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== PERCENT || src.charCodeAt(start + 1) !== PERCENT) return false;
    const end = src.indexOf("%%", start + 2);
    if (end < 0 || end >= state.posMax) return false;
    if (!silent) state.pending += "";
    state.pos = end + 2;
    return true;
  });

  md.block.ruler.before("paragraph", "comment", (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const first = state.bMarks[startLine] + state.tShift[startLine];
    const lineEnd = state.eMarks[startLine];
    if (!state.src.startsWith("%%", first)) return false;

    const sameLine = state.src.indexOf("%%", first + 2);
    if (sameLine >= 0 && sameLine < lineEnd) {
      // `%% note %%` alone on its line vanishes; with trailing text it stays an inline comment.
      if (state.src.slice(sameLine + 2, lineEnd).trim()) return false;
      if (silent) return true;
      state.line = startLine + 1;
      return true;
    }

    let line = startLine + 1;
    let closed = false;
    for (; line < endLine; line++) {
      const from = state.bMarks[line];
      const to = state.eMarks[line];
      const at = state.src.indexOf("%%", from);
      if (at >= 0 && at < to) {
        closed = true;
        break;
      }
    }
    if (silent) return true;
    state.line = closed ? line + 1 : endLine;
    return true;
  });
}
