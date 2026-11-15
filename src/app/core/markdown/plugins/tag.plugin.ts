import type { MarkdownIt } from "markdown-it";

const HASH = 0x23;
const TAG_CHAR = /[\p{L}\p{N}_\-/]/u;

/**
 * Obsidian `#tag` (nested with `/`, unicode letters, at least one non-digit).
 * Renders `<a class="tag">` and collects the names in `env.tags`. Runs as an inline
 * rule, so code spans and fences are never scanned.
 */
export function tagPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("emphasis", "tag", (state, silent) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== HASH) return false;
    if (start > 0 && !/[\s([{"']/.test(src[start - 1])) return false;

    let end = start + 1;
    while (end < state.posMax && TAG_CHAR.test(src[end])) end++;
    // Trailing separators are punctuation, not part of the tag.
    while (end > start + 1 && /[-/]/.test(src[end - 1])) end--;
    const name = src.slice(start + 1, end);
    if (!name || !/[^\p{N}]/u.test(name.replace(/[-/_]/g, ""))) return false;
    if (name.split("/").some((part) => !part)) return false;

    if (!silent) {
      const open = state.push("tag_open", "a", 1);
      open.attrSet("class", "tag");
      open.attrSet("href", "#");
      open.attrSet("data-tag", name);
      state.push("text", "", 0).content = `#${name}`;
      state.push("tag_close", "a", -1);
      const env = state.env as { tags?: string[] };
      (env.tags ??= []).push(name);
    }
    state.pos = end;
    return true;
  });
}
