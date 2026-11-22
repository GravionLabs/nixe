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

  it("switches the view mode with icon buttons, no text labels and no select", () => {
    expect(html).not.toContain("<select");
    expect(html).toMatch(/class="icon toggle"/);
    expect(html).toContain('[attr.aria-label]="m.label"');
    expect(html).toContain('[hx-tooltip]="m.label"');
  });

  it("centres the path in the window: equal columns for start and end", () => {
    expect(css).toMatch(
      /hx-app-toolbar\s*\{[^}]*display: grid;[^}]*grid-template-columns: minmax\(max-content, 1fr\) minmax\(0, auto\) minmax\(max-content, 1fr\)/,
    );
    expect(css).toMatch(/\.hx-app-toolbar-end\s*\{[^}]*justify-content: flex-end/);
    expect(css).toMatch(/\.crumbs\s*\{[^}]*justify-content: center/);
  });

  it("gives the bar room above and below the 22 px controls", () => {
    expect(css).toMatch(/hx-app-toolbar\s*\{[^}]*height: 32px/);
  });

  it("does not contain the size of the view mode group (it would collapse to no width)", () => {
    expect(css).not.toContain("container-type");
  });
});
