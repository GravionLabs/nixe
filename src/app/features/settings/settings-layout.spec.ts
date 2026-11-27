import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "settings.component.css"), "utf8");

describe("settings layout", () => {
  it("lets the label take only what the control leaves (#457)", () => {
    // With the default flex basis a long description squeezed the access token column to 66 px.
    expect(css).toMatch(/\.row\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/);
  });

  it("limits the sections to a readable width (#544)", () => {
    expect(css).toMatch(/\.group,\s*hx-fieldset\s*\{[^}]*max-width: 760px/);
  });

  it("keeps the scrollbar at the page edge: .content has no maximum width (#544)", () => {
    expect(css).not.toMatch(/\.content\s*\{[^}]*max-width/);
  });

  it("gives selects, text and number inputs the same box, width and height (#629)", () => {
    const html = readFileSync(resolve(__dirname, "settings.component.html"), "utf8");
    const controls = html.match(
      /<(?:hx-select|input(?=[^>]*type="(?:text|number)")(?=[^>]*item\.(?:min|placeholder)))\b[^>]*>/g,
    );
    expect(controls).toHaveLength(3);
    for (const control of controls!) expect(control).toContain('class="sized"');
    const rule = /\.control > \.sized\s*\{([^}]*)\}/.exec(css)?.[1];
    expect(rule).toMatch(/box-sizing: border-box;/);
    expect(css).toMatch(/--settings-control-width: 200px;/);
    expect(rule).toMatch(/\bwidth: var\(--settings-control-width\);/);
    expect(rule).toMatch(/\bheight: 34px;/);
  });

  it("puts the search field above the section list, in the left column (#722)", () => {
    const html = readFileSync(resolve(__dirname, "settings.component.html"), "utf8");
    const side = html.indexOf('<div class="side">');
    expect(side).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("#search")).toBeGreaterThan(side);
    expect(html.indexOf("#search")).toBeLessThan(html.indexOf("<nav "));
  });

  it("starts the locations list at the height of its label (#722)", () => {
    expect(css).toMatch(
      /\.row:has\(\.locations\)\s*\{[^}]*grid-template-rows: auto 1fr;\s*align-items: start;/,
    );
    expect(css).toMatch(
      /\.row:has\(\.locations\) ::ng-deep > \.hx-field-label\s*\{\s*align-self: start;/,
    );
    // Every other row stays centred.
    expect(css).toMatch(/\.row\s*\{[^}]*align-items: center;/);
  });

  it("lines the access token up with the controls of the other rows (#722)", () => {
    expect(css).toMatch(
      /\.row:has\(\.token\)\s*\{[^}]*minmax\(0, var\(--settings-control-width\)\)/,
    );
    expect(css).toMatch(/\.token \{[^}]*text-align: right;/);
    for (const part of ["state", "manual"]) {
      expect(css).toMatch(new RegExp(`\\.token-${part} \\{[^}]*justify-content: flex-end;`));
    }
    // The narrow layout stacks and aligns to the left again, after the base rules.
    const narrow = css.indexOf("@container (max-width: 440px)");
    expect(narrow).toBeGreaterThan(css.indexOf(".token {"));
    expect(css.slice(narrow)).toMatch(/grid-template-rows: none;/);
    expect(css.slice(narrow)).toMatch(/\.token \.readonly\s*\{\s*text-align: left;/);
  });
});
