import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const doc = readFileSync(resolve(root, "AGENTS.md"), "utf8");
const guide = readFileSync(resolve(root, "docs/STYLEGUIDE.md"), "utf8");
const base = "node_modules/@gravionlabs/helix-ui/styleguide/STYLEGUIDE.md";
const ui = /^## UI\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(doc)?.[1] ?? "";

describe("AGENTS.md, UI section", () => {
  it("links the app style guide instead of the UX rules", () => {
    expect(ui).toContain("(docs/STYLEGUIDE.md)");
    expect(ui).not.toContain("UX-RULES.md");
  });

  it("names the base guide that the app guide extends", () => {
    expect(ui).toContain(`\`${base}\``);
  });

  it.each(["<button>", "<input>", "<select>", "<textarea>", "<progress>"])(
    "names the rule against a raw %s",
    (control) => {
      expect(ui).toMatch(new RegExp(`never a raw .*\`${control}\`.* without a Helix directive`));
    },
  );

  it("links the mapping of the controls to an existing file", () => {
    const mapping = ".agents/skills/ng-implementation/references/helix.md";
    expect(ui).toContain(`(${mapping})`);
    expect(existsSync(resolve(root, mapping))).toBe(true);
  });

  it("forbids component CSS for controls and takes colors and font sizes from the tokens", () => {
    expect(ui).toContain("No component CSS that styles controls");
    expect(ui).toContain("colors and font sizes come from the `--h-*` tokens");
  });
});

describe("docs/STYLEGUIDE.md", () => {
  it("extends the Helix base guide that the installed package ships", () => {
    expect(guide.split("\n")[0]).toBe(`Extends: ${base}`);
    expect(existsSync(resolve(root, base))).toBe(true);
  });

  it("has a Deviations section with a reason or an open question in every row", () => {
    const deviations = /^## Deviations\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(guide)?.[1] ?? "";
    // The first two table lines are the header and its separator.
    const rows = deviations
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .slice(2);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const cells = row.split("|").slice(1, -1);
      expect(cells.map((cell) => cell.trim()).filter(Boolean), row).toHaveLength(3);
    }
  });

  it("stays within 100 lines", () => {
    expect(guide.trimEnd().split("\n").length).toBeLessThanOrEqual(100);
  });
});
