import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #371: github-markdown-css gives `.markdown-body` its own canvas colour and `font-size: 16px`; the live
// preview widgets (table, callout, embed) must take the note's background and size instead.
describe("live preview block widget styles", () => {
  const scss = readFileSync(resolve(__dirname, "../styles.scss"), "utf8");
  const overrides = scss.slice(scss.indexOf(":root.app-dark {"));
  const block = (selector: string): string => {
    const start = overrides.indexOf(selector);
    expect(start, selector).toBeGreaterThan(-1);
    return overrides.slice(start, overrides.indexOf("}", start));
  };

  it("lets a widget take the note background and text size", () => {
    const rule = block(".markdown-body.cm-live-block");
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).toMatch(/font-size:\s*inherit/);
  });

  it("colours the table rows with the helix tokens", () => {
    expect(block(".markdown-body table tr {")).toContain("var(--h-content-background)");
    expect(block(".markdown-body table tr:nth-child(2n)")).toContain("var(--h-surface-frame)");
  });

  it("sits after the github rules and repeats their root selectors", () => {
    expect(scss.indexOf("github-markdown-light.css")).toBeLessThan(
      scss.indexOf(".markdown-body.cm-live-block"),
    );
    expect(overrides).toMatch(/:root:not\(\.app-dark\),\s*:root\.app-dark\s*\{/);
  });
});
