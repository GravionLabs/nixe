import { MAX_EMBED_DEPTH, extractBlock, extractHeadingSection } from "./embed";
import { splitFrontmatter } from "./frontmatter";
import { joinPath } from "./paths";
import { parseWikilinkTarget, resolveWikilink } from "./wikilink-resolver";

export interface EmbedDeps {
  vaultRoot: string;
  vaultFiles: readonly string[];
  /** Reads a note through the existing read command. */
  read(absolutePath: string): Promise<string>;
  /** Renders markdown with the normal pipeline and returns sanitized HTML. */
  render(text: string, absolutePath: string): string;
}

function placeholder(el: Element, message: string): void {
  const body = el.querySelector(":scope > .embed-body");
  if (!body) return;
  body.textContent = message;
  el.classList.add("embed-placeholder");
}

/**
 * Fills every `.embed[data-embed]` below `root`. `stack` holds the vault-relative notes being
 * embedded (starting with the current one): a repeat is a cycle, and more than
 * `MAX_EMBED_DEPTH` levels is too deep. Both render a placeholder instead of recursing.
 */
export async function expandEmbeds(root: ParentNode, deps: EmbedDeps, stack: readonly string[]): Promise<void> {
  const embeds = Array.from(root.querySelectorAll<HTMLElement>(".embed[data-embed]"));
  for (const el of embeds) {
    if (el.dataset["expanded"]) continue;
    el.dataset["expanded"] = "1";
    const target = el.dataset["embed"] ?? "";
    const resolved = resolveWikilink(target, deps.vaultFiles);
    if (!resolved) {
      placeholder(el, `Note not found: ${target}`);
      continue;
    }
    if (stack.includes(resolved)) {
      placeholder(el, `Embed cycle: ${resolved}`);
      continue;
    }
    if (stack.length > MAX_EMBED_DEPTH) {
      placeholder(el, `Embed too deep: ${resolved}`);
      continue;
    }
    const abs = joinPath(deps.vaultRoot, resolved);
    let text: string;
    try {
      text = await deps.read(abs);
    } catch (err) {
      placeholder(el, `Cannot read ${resolved}: ${String(err)}`);
      continue;
    }
    const { heading, block } = parseWikilinkTarget(target);
    let part: string | null = splitFrontmatter(text).body;
    if (heading) part = extractHeadingSection(text, heading);
    else if (block) part = extractBlock(text, block);
    if (part === null) {
      placeholder(el, `Section not found: ${target}`);
      continue;
    }
    const body = el.querySelector(":scope > .embed-body");
    if (!body) continue;
    body.innerHTML = deps.render(part, abs); // sanitized by the caller's render
    await expandEmbeds(body, deps, [...stack, resolved]);
  }
}
