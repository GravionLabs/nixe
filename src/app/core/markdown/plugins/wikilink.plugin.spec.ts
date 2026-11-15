import { describe, expect, it } from "vitest";
import { createMarkdownRenderer } from "../markdown-renderer";

const md = createMarkdownRenderer({ math: false });
const render = (src: string, vaultFiles?: string[]) => md.render(src, { vaultFiles });

describe("wikilink plugin", () => {
  it("renders the supported forms", () => {
    const html = render("[[Note]] [[Note|Alias]] [[Note#Head]] [[Note#^b1]] [[folder/Note]] [[Note.md]]");
    expect(html).toContain('<a class="wikilink" data-target="Note" href="#">Note</a>');
    expect(html).toContain('data-target="Note" href="#">Alias</a>');
    expect(html).toContain('data-target="Note#Head"');
    expect(html).toContain('data-target="Note#^b1"');
    expect(html).toContain('data-target="folder/Note"');
    expect(html).toContain('data-target="Note.md"');
  });
  it("marks unresolved and ambiguous targets", () => {
    const html = render("[[Note]] [[Gone]] [[Dup]]", ["Note.md", "a/Dup.md", "b/Dup.md"]);
    expect(html).toContain('class="wikilink" data-target="Note"');
    expect(html).toContain('class="wikilink unresolved" data-target="Gone"');
    expect(html).toContain('class="wikilink unresolved" data-target="Dup"');
  });
  it("leaves code spans and fences alone", () => {
    expect(render("`[[Note]]`")).not.toContain("wikilink");
    expect(render("```\n[[Note]]\n```")).not.toContain("wikilink");
  });
  it("leaves the Azure DevOps TOC marker alone", () => {
    expect(render("text [[_TOC_]]")).not.toContain("wikilink");
  });
});
