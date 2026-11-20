import { describe, expect, it } from "vitest";
import { createMarkdownRenderer } from "../markdown-renderer";

const md = createMarkdownRenderer({ math: false });
const files = ["Note.md", "assets/image.png", "assets/doc.pdf"];
const render = (src: string, vaultFiles: string[] | undefined = files) =>
  md.render(src, { vaultFiles, vaultRoot: "/v" });

describe("embed plugin", () => {
  it("renders note embeds as placeholders with a title link", () => {
    for (const t of ["Note", "Note#Heading", "Note#^b1"]) {
      const html = render(`![[${t}]]`);
      expect(html).toContain(`<div class="embed" data-embed="${t}">`);
      expect(html).toContain(`<a class="wikilink" data-target="${t}" href="#">`);
    }
  });
  it("marks unresolved note embeds", () => {
    expect(render("![[Gone]]")).toContain('class="embed unresolved"');
  });
  it("renders images by basename with sizes", () => {
    expect(render("![[image.png]]")).toContain('src="/v/assets/image.png"');
    expect(render("![[image.png|300]]")).toContain('width="300"');
    const html = render("![[image.png|300x200]]");
    expect(html).toContain('width="300"');
    expect(html).toContain('height="200"');
  });
  it("renders other files as links", () => {
    expect(render("![[doc.pdf]]")).toContain(
      '<a class="wikilink embed-file" data-target="doc.pdf"',
    );
  });
  it("leaves code alone and normal images intact", () => {
    expect(render("`![[Note]]`")).not.toContain("embed");
    expect(render("![alt](a.png)")).toContain('<img src="a.png" alt="alt"');
  });
});
