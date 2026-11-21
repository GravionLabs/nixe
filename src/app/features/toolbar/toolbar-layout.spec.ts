import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "toolbar.component.css"), "utf8");
const html = readFileSync(resolve(__dirname, "toolbar.component.html"), "utf8");

describe("toolbar layout", () => {
  it("has no select for the properties, only icon buttons next to the view mode", () => {
    expect(html).not.toContain('select\n    slot="end"');
    expect(html).not.toMatch(/<select[^>]*class="props"/);
    expect(html).toMatch(/<button[^>]*class="icon props"/);
  });

  it("keeps the labels of the view mode switch on one line", () => {
    expect(css).toMatch(/\.toggle\s*\{[^}]*white-space: nowrap/);
  });

  it("swaps the segments for a bounded select at 720 px and below", () => {
    const media = css.match(/@media \(max-width: 720px\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? "";
    expect(media).toMatch(/\.seg\s*\{\s*display: none/);
    expect(media).toMatch(/select\.compact\s*\{[^}]*max-width: 120px/);
  });
});
