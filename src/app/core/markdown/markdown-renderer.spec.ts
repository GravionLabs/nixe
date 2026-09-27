import { describe, expect, it } from "vitest";
import { createMarkdownRenderer, slugify } from "./markdown-renderer";
import { dedent } from "./plugins/ado-mermaid.plugin";

const md = createMarkdownRenderer({ math: true });
const render = (src: string) => md.render(src);

describe("mermaid fences", () => {
  it("renders ```mermaid as placeholder", () => {
    const html = render("```mermaid\ngraph TD; A-->B\n```\n");
    expect(html).toContain('<pre class="mermaid" data-line="0">graph TD; A--&gt;B\n</pre>');
  });

  it("keeps other fences as highlighted code", () => {
    const html = render("```ts\nconst a = 1;\n```\n");
    expect(html).toContain('<code data-line="0" class="language-ts">');
    expect(html).toContain("hljs-keyword");
    expect(html).not.toContain("mermaid");
  });
});

describe("Azure DevOps ::: mermaid", () => {
  it("renders indented block", () => {
    const html = render("Text\n\n::: mermaid\n graph LR;\n   A --> B;\n:::\n\nAfter\n");
    expect(html).toContain('<pre class="mermaid" data-line="2">graph LR;\n  A --&gt; B;\n</pre>');
    expect(html).toContain("<p data-line=\"7\">After</p>");
  });

  it("accepts :::mermaid without space and any case", () => {
    const html = render(":::Mermaid\nsequenceDiagram\nA->>B: hi\n:::\n");
    expect(html).toContain('<pre class="mermaid"');
    expect(html).toContain("sequenceDiagram");
  });

  it("interrupts a paragraph", () => {
    const html = render("Intro line\n::: mermaid\ngraph TD\n:::\n");
    expect(html).toContain("<p data-line=\"0\">Intro line</p>");
    expect(html).toContain('<pre class="mermaid"');
  });

  it("handles multiple blocks", () => {
    const html = render("::: mermaid\ngraph TD\n:::\n\n::: mermaid\npie\n:::\n");
    expect(html.match(/class="mermaid"/g)).toHaveLength(2);
  });

  it("consumes to end of document when closing marker is missing", () => {
    const html = render("::: mermaid\ngraph TD\nA-->B\n");
    expect(html).toContain("graph TD\nA--&gt;B\n</pre>");
  });

  it("ignores other ::: containers", () => {
    expect(render("::: note\nhi\n:::\n")).not.toContain("mermaid");
  });

  it("dedent keeps relative indentation", () => {
    expect(dedent("    a\n      b\n\n    c\n")).toBe("a\n  b\n\nc\n");
  });
});

describe("[[_TOC_]]", () => {
  it("renders nested table of contents", () => {
    const html = render("[[_TOC_]]\n\n# Eins\n\n## Zwei `code`\n\n# Drei\n");
    expect(html).toContain('<nav class="toc">');
    expect(html).toContain('<a href="#eins">Eins</a>');
    expect(html).toContain('<a href="#zwei-code">Zwei code</a>');
    expect(html.indexOf("#zwei-code")).toBeGreaterThan(html.indexOf("#eins"));
    expect(html.match(/<ul>/g)).toHaveLength(2);
  });

  it("renders nothing without headings", () => {
    expect(render("[[_TOC_]]\n")).toBe("");
  });
});

describe("headings & extras", () => {
  it("creates GitHub-style ids", () => {
    expect(render("## Hallo Welt: Übersicht!\n")).toContain('id="hallo-welt-übersicht"');
    expect(slugify("A  B")).toBe("a--b");
  });

  it("renders task lists and footnotes", () => {
    const html = render("- [x] erledigt\n- [ ] offen\n\nText[^1]\n\n[^1]: Fußnote\n");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("footnote");
  });

  it("renders math with KaTeX when enabled", () => {
    expect(render("$E=mc^2$")).toContain('class="katex"');
    expect(render("$$\n\\int_0^1 x\\,dx\n$$\n")).toContain("katex-display");
  });

  it("leaves math untouched when disabled", () => {
    const plain = createMarkdownRenderer({ math: false });
    expect(plain.render("$E=mc^2$")).toContain("$E=mc^2$");
  });
});
