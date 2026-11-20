import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMarkdownRenderer } from "./markdown-renderer";

const vault = "fixtures/vault";
const walk = (dir: string): string[] =>
  readdirSync(`${vault}/${dir}`, { withFileTypes: true }).flatMap((e) =>
    e.name.startsWith(".") ? [] : e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`],
  );

describe("fixtures/vault/Embeds.md", () => {
  it("covers every embed form", () => {
    const html = createMarkdownRenderer({ math: false }).render(
      readFileSync(`${vault}/Embeds.md`, "utf8"),
      {
        vaultFiles: walk(""),
        vaultRoot: "/vault",
      },
    );
    for (const t of ["Note", "Note#Second heading", "Note#^block1", "Loop A", "L1"]) {
      expect(html).toContain(`<div class="embed" data-embed="${t}">`);
    }
    expect(html).toContain('src="/vault/assets/image.svg"');
    expect(html).toContain('width="100"');
    expect(html).toContain('height="60"');
    expect(html).toContain('class="wikilink embed-file" data-target="doc.pdf"');
    expect(html).toContain('class="embed unresolved" data-embed="Nope"');
  });
});
