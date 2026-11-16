import type { MarkdownIt } from "markdown-it";

import { resolveWikilink } from "../wikilink-resolver";

/** Render environment: the vault's files let the plugin mark unresolved links. */
export interface WikilinkEnv {
  vaultFiles?: readonly string[] | null;
}

/**
 * Obsidian `[[Note]]`, `[[Note|Alias]]`, `[[Note#Heading]]`, `[[Note#^block]]`, `[[folder/Note]]`
 * and `[[Note.md]]` become `<a class="wikilink" data-target="…">`. Without `env.vaultFiles` no link
 * is marked unresolved. Code spans and fences are consumed by markdown-it before this rule runs.
 */
export function wikilinkPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf("]]", start + 2);
    if (end < 0) return false;
    const inner = src.slice(start + 2, end);
    if (!inner.trim() || inner.includes("[") || inner.includes("\n")) return false;
    if (inner.trim().toLowerCase() === "_toc_") return false; // Azure DevOps TOC marker

    if (!silent) {
      const pipe = inner.indexOf("|");
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";
      if (!target) return false;

      const files = (state.env as WikilinkEnv | undefined)?.vaultFiles;
      const resolved = !files || target.startsWith("#") || resolveWikilink(target, files) !== null;

      const open = state.push("wikilink_open", "a", 1);
      open.attrSet("class", resolved ? "wikilink" : "wikilink unresolved");
      open.attrSet("data-target", target);
      open.attrSet("href", "#");
      state.push("text", "", 0).content = alias || target;
      state.push("wikilink_close", "a", -1);
    }
    state.pos = end + 2;
    return true;
  });
}
