import type { MarkdownIt } from "markdown-it";

import { parseEmbed } from "../embed";
import { joinPath } from "../paths";
import { resolveWikilink } from "../wikilink-resolver";

/** Render environment for embeds. */
export interface EmbedEnv {
  vaultFiles?: readonly string[] | null;
  /** Absolute vault root; lets embedded images resolve to absolute paths. */
  vaultRoot?: string | null;
}

/**
 * Obsidian `![[Note]]`, `![[Note#Heading]]`, `![[Note#^block]]`, `![[image.png|300x200]]` and
 * `![[file.pdf]]`. Notes become an `<div class="embed" data-embed="…">` placeholder that the viewer
 * fills asynchronously (see embed-expander.ts); images become `<img>`, other files a link.
 */
export function embedPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("image", "embed", (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (
      src.charCodeAt(start) !== 0x21 ||
      src.charCodeAt(start + 1) !== 0x5b ||
      src.charCodeAt(start + 2) !== 0x5b
    ) {
      return false;
    }
    const end = src.indexOf("]]", start + 3);
    if (end < 0) return false;
    const inner = src.slice(start + 3, end);
    if (inner.includes("[") || inner.includes("\n")) return false;
    const embed = parseEmbed(inner);
    if (!embed) return false;

    if (!silent) {
      const env = (state.env ?? {}) as EmbedEnv;
      const files = env.vaultFiles;
      const resolved = files ? resolveWikilink(embed.target, files) : null;
      if (embed.kind === "note") {
        const t = state.push("embed", "", 0);
        t.content = embed.target;
        t.meta = { unresolved: !!files && !resolved };
      } else if (embed.kind === "image") {
        const path = resolved
          ? env.vaultRoot
            ? joinPath(env.vaultRoot, resolved)
            : resolved
          : embed.target;
        const img = state.push("image", "img", 0);
        img.attrs = [
          ["src", path],
          ["alt", embed.target],
        ];
        if (embed.width !== null) img.attrSet("width", String(embed.width));
        if (embed.height !== null) img.attrSet("height", String(embed.height));
        img.children = [];
        img.content = embed.target;
      } else {
        const open = state.push("wikilink_open", "a", 1);
        open.attrSet(
          "class",
          files && !resolved ? "wikilink embed-file unresolved" : "wikilink embed-file",
        );
        open.attrSet("data-target", embed.target);
        open.attrSet("href", "#");
        state.push("text", "", 0).content = embed.target;
        state.push("wikilink_close", "a", -1);
      }
    }
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules["embed"] = (tokens, idx) => {
    const t = tokens[idx];
    const target = md.utils.escapeHtml(t.content);
    const cls = t.meta?.["unresolved"] ? "embed unresolved" : "embed";
    return (
      `<div class="${cls}" data-embed="${target}">` +
      `<div class="embed-title"><a class="wikilink${t.meta?.["unresolved"] ? " unresolved" : ""}" data-target="${target}" href="#">${target}</a></div>` +
      `<div class="embed-body"></div></div>`
    );
  };
}
