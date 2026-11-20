import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const doc = readFileSync(resolve(root, "docs/theming.md"), "utf8");
const styles = readFileSync(resolve(root, "src/styles.scss"), "utf8");

describe("docs/theming.md", () => {
  it("documents every --nixe-* variable that styles.scss defines", () => {
    const defined = [...styles.matchAll(/^\s*(--nixe-[a-z-]+):/gm)].map((m) => m[1]);
    expect(defined.length).toBeGreaterThan(5);
    for (const name of new Set(defined)) expect(doc, name).toContain(`\`${name}\``);
  });

  it("says that Obsidian themes and snippets are not loaded and maps variables", () => {
    expect(doc).toContain("Obsidian themes and `.obsidian/snippets/` are **not** loaded");
    expect(doc).toContain("`--interactive-accent`");
    expect(doc).toContain("`--font-monospace`");
  });

  it("is linked from the docs index", () => {
    expect(readFileSync(resolve(root, "docs/README.md"), "utf8")).toContain("(theming.md)");
  });
});
