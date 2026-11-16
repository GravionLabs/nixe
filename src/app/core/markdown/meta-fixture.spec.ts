import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { extractBlock } from "./embed";
import { detectType } from "./properties";
import { splitFrontmatter } from "./frontmatter";
import { createMarkdownRenderer } from "./markdown-renderer";
import { isMarkdownPath } from "./paths";
import { parseWikilinkTarget } from "./wikilink-resolver";

// The Rust extractor (`vault::meta`) is checked against the same `.meta/*.json` files.
const vault = "fixtures/vault";
const notes = (dir: string): string[] =>
  readdirSync(`${vault}/${dir}`, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith(".") ? [] : e.isDirectory() ? notes(`${dir}${e.name}/`) : e.name.endsWith(".md") ? [`${dir}${e.name}`] : [],
  );

interface Link {
  target: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
  embed: boolean;
}

const md = createMarkdownRenderer({ math: false });

function link(target: string, alias: string | null, embed: boolean): Link {
  const { note, heading, block } = parseWikilinkTarget(target);
  return { target: note, heading, block, alias, embed };
}

/** Metadata as the TypeScript parser sees it (markdown-it tokens plus the frontmatter helpers). */
function extractWithMarkdownIt(text: string) {
  const fm = splitFrontmatter(text);
  const env: { tags?: string[] } = {};
  const tokens = md.parse(fm.body, env);

  const links: Link[] = [];
  const markdownLinks: { target: string; heading: string | null }[] = [];
  const headings: { level: number; text: string }[] = [];

  tokens.forEach((token, i) => {
    if (token.type === "heading_open") {
      headings.push({ level: Number(token.tag.slice(1)), text: tokens[i + 1].content.trim() });
    }
    for (const [j, child] of (token.children ?? []).entries()) {
      if (child.type === "wikilink_open") {
        const target = child.attrGet("data-target") ?? "";
        const shown = token.children![j + 1].content;
        const embedFile = (child.attrGet("class") ?? "").includes("embed-file");
        links.push(link(target, shown === target ? null : shown, embedFile));
      } else if (child.type === "embed") {
        links.push(link(child.content, null, true));
      } else if (child.type === "image" && child.attrGet("alt") && child.attrGet("alt") === child.content) {
        links.push(link(child.content, null, true));
      } else if (child.type === "link_open") {
        const href = child.attrGet("href") ?? "";
        if (/^[a-z][a-z0-9+.-]+:/i.test(href)) continue;
        const [path, fragment] = href.split("#");
        const decoded = decodeURIComponent(path);
        if (isMarkdownPath(decoded)) markdownLinks.push({ target: decoded, heading: fragment || null });
      }
    }
  });

  const blocks = [...fm.body.matchAll(/(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/gm)]
    .map((m) => m[1])
    .filter((id) => extractBlock(fm.body, id) !== null);

  const properties = Object.entries(fm.data).map(([key, value]) => {
    const type = detectType("-", value); // a neutral key: no chip lists
    return { key, type: type === "link" || type === "tags" ? "text" : type, value: value ?? null };
  });
  const list = (keys: string[], separator: RegExp) =>
    Object.entries(fm.data)
      .filter(([k]) => keys.includes(k.toLowerCase()))
      .flatMap(([, v]) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(separator) : []))
      .map((s) => s.trim())
      .filter(Boolean);
  const tags = [...new Set([...list(["tags", "tag"], /[,\s]+/).map((t) => t.replace(/^#/, "")), ...(env.tags ?? [])])];

  return {
    links,
    markdownLinks,
    tags,
    headings,
    blocks: [...new Set(blocks)],
    properties,
    aliases: list(["aliases", "alias"], /,/),
    warnings: fm.error ? ["invalid-frontmatter"] : [],
  };
}

describe("fixtures/vault expected metadata", () => {
  it("covers every note", () => {
    expect(notes("").length).toBeGreaterThanOrEqual(10);
  });

  it.each(notes(""))("%s", (note) => {
    const expected = JSON.parse(readFileSync(`${vault}/.meta/${note}.json`, "utf8"));
    const actual = extractWithMarkdownIt(readFileSync(`${vault}/${note}`, "utf8"));
    // Embed sizes (`|100x60`) are not kept by the markdown-it plugin.
    const withoutEmbedAlias = (links: Link[]) => links.map((l) => (l.embed ? { ...l, alias: null } : l));
    expect({ ...actual, links: withoutEmbedAlias(actual.links) }).toEqual({
      ...expected,
      links: withoutEmbedAlias(expected.links),
    });
  });
});
