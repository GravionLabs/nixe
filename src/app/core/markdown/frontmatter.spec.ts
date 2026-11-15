import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { splitFrontmatter } from "./frontmatter";
import { createMarkdownRenderer } from "./markdown-renderer";
import { renderNote } from "./note";
import { detectType, frontmatterTags, renderLinks } from "./properties";

const md = createMarkdownRenderer({ math: false });

describe("splitFrontmatter", () => {
  it("splits the YAML block and keeps line numbers", () => {
    const r = splitFrontmatter("---\ntitle: Hi\nn: 1\n---\n# Body\n");
    expect(r.present).toBe(true);
    expect(r.data).toEqual({ title: "Hi", n: 1 });
    expect(r.body).toBe("\n\n\n\n# Body\n");
    expect(r.error).toBeNull();
  });

  it("ignores a fence that is not at the top", () => {
    const r = splitFrontmatter("text\n---\na: 1\n---\n");
    expect(r.present).toBe(false);
    expect(r.body).toContain("a: 1");
  });

  it("needs a closing fence", () => {
    expect(splitFrontmatter("---\na: 1\n").present).toBe(false);
  });

  it("handles CRLF and an empty block", () => {
    expect(splitFrontmatter("---\r\na: 1\r\n---\r\nx").data).toEqual({ a: 1 });
    expect(splitFrontmatter("---\n---\nx").data).toEqual({});
  });

  it("reports invalid YAML instead of throwing", () => {
    const r = splitFrontmatter("---\ntitle: [unclosed\n---\nbody");
    expect(r.error).toBeTruthy();
    expect(r.data).toEqual({});
    expect(r.body.endsWith("body")).toBe(true);
  });

  it("rejects non-mapping YAML", () => {
    expect(splitFrontmatter("---\n- a\n- b\n---\n").error).toMatch(/mapping/);
  });
});

describe("property types", () => {
  it.each([
    ["title", "Hello", "text"],
    ["n", 3, "number"],
    ["ok", true, "checkbox"],
    ["d", "2026-11-15", "date"],
    ["d", "2026-11-15T10:30:00", "date"],
    ["l", ["a", "b"], "list"],
    ["r", "[[Note]]", "link"],
    ["tags", ["a"], "tags"],
    ["aliases", ["a"], "tags"],
    ["x", null, "text"],
  ])("%s = %j is %s", (key, value, type) => {
    expect(detectType(key, value)).toBe(type);
  });

  it("renders wikilinks with alias and heading", () => {
    const html = renderLinks("see [[Home|Wiki]] and [[a#b]] <x>");
    expect(html).toContain('<a class="wikilink" href="Home" data-wikilink="Home">Wiki</a>');
    expect(html).toContain('href="a#b"');
    expect(html).toContain("&lt;x&gt;");
  });

  it("normalizes frontmatter tags", () => {
    expect(frontmatterTags({ tags: ["#a", "b/c"] })).toEqual(["a", "b/c"]);
    expect(frontmatterTags({ tags: "a, b" })).toEqual(["a", "b"]);
  });
});

describe("inline tags", () => {
  const tags = (src: string) => renderNote(md, src).tags;

  it("renders nested and unicode tags as links", () => {
    const { html, tags } = renderNote(md, "A #project/nixe and #übersicht.\n");
    expect(html).toContain('<a class="tag" href="#" data-tag="project/nixe">#project/nixe</a>');
    expect(html).toContain('data-tag="übersicht"');
    expect(tags).toEqual(["project/nixe", "übersicht"]);
  });

  it("ignores code, headings, digit-only, urls and mid-word hashes", () => {
    expect(tags("`#code`\n")).toEqual([]);
    expect(tags("```\n#fence\n```\n")).toEqual([]);
    expect(tags("# Heading\n")).toEqual([]);
    expect(tags("issue #123\n")).toEqual([]);
    expect(tags("see http://x.org/#frag and a#b\n")).toEqual([]);
  });

  it("merges frontmatter and inline tags uniquely", () => {
    expect(tags("---\ntags: [a, b]\n---\n#b #c\n")).toEqual(["a", "b", "c"]);
  });
});

describe("properties panel", () => {
  it("renders chips, checkbox and links", () => {
    const { html } = renderNote(md, "---\ntags: [x]\nok: true\nr: '[[N]]'\n---\nBody\n");
    expect(html).toContain('<dl class="properties">');
    expect(html).toContain('<a class="tag" href="#">#x</a>');
    expect(html).toContain('<input type="checkbox" disabled checked>');
    expect(html).toContain('class="wikilink"');
    expect(html).toContain("Body");
  });

  it("shows a warning and still renders the body on invalid YAML", () => {
    const { html, frontmatterError } = renderNote(md, "---\na: [x\n---\nBody\n");
    expect(frontmatterError).toBeTruthy();
    expect(html).toContain("frontmatter-warning");
    expect(html).toContain("Body");
  });

  it("escapes values", () => {
    expect(renderNote(md, "---\nt: <b>x</b>\n---\n").html).toContain("&lt;b&gt;");
  });

  it("covers all property types in the fixture vault", () => {
    const text = readFileSync("fixtures/properties.md", "utf8");
    const { properties } = renderNote(md, text);
    const types = new Set(properties.map((p) => p.type));
    for (const t of ["text", "number", "checkbox", "date", "list", "link", "tags"]) {
      expect(types).toContain(t);
    }
  });
});
