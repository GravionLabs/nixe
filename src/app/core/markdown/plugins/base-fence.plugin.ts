import type { MarkdownIt } from "markdown-it";

/** The class of the element a ```base fence renders to. */
export const BASE_BLOCK_CLASS = "base-block";

/** The HTML of a base block; `attributes` say where its base comes from. */
export function baseBlockHtml(attributes: string): string {
  return `<div class="${BASE_BLOCK_CLASS}" ${attributes}><p class="base-placeholder">${BASE_PLACEHOLDER}</p></div>`;
}

/** What the block says where it is not shown as its base: export, link preview. */
export const BASE_PLACEHOLDER = "Base: shown in the reading view of Nixe.";

/**
 * Renders ```base fences as a placeholder that carries the source of the base. The reading view
 * puts the base in its place (see `features/bases/base-blocks.ts`).
 */
export function baseFencePlugin(md: MarkdownIt): void {
  const fallback = md.renderer.rules["fence"]!;

  md.renderer.rules["fence"] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const lang = token.info.trim().split(/\s+/)[0]?.toLowerCase();
    if (lang !== "base") {
      return fallback(tokens, idx, options, env, self);
    }
    const line = token.map ? ` data-line="${token.map[0]}"` : "";
    // Encoded, so that the sanitizer keeps the attribute whatever the source holds (`-->`).
    const source = encodeURIComponent(token.content.replace(/\p{Surrogate}/gu, "�"));
    return `${baseBlockHtml(`data-base="${source}"${line}`)}\n`;
  };
}
