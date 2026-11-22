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

  it("has the view mode as icon buttons and no select", () => {
    expect(html).not.toContain("<select");
    expect(html).toMatch(/class="icon toggle"/);
    expect(css).not.toContain("select.compact");
  });

  it("centres the path with a grid of equal start and end", () => {
    expect(css).toMatch(
      /grid-template-columns:\s*minmax\(max-content, 1fr\) minmax\(0, auto\) minmax\(max-content, 1fr\)/,
    );
    expect(css).toMatch(/hx-app-toolbar\s*\{[^}]*height: 34px/);
  });

  it("does not contain the size of the view mode group (it would collapse to no width)", () => {
    expect(css).not.toContain("container-type");
  });
});
