import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const doc = readFileSync(resolve(root, "AGENTS.md"), "utf8");
const ui = /^## UI\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(doc)?.[1] ?? "";

describe("AGENTS.md, UI section", () => {
  it("links the Helix UX rules", () => {
    expect(ui).toContain("(https://github.com/GravionLabs/helix/blob/main/docs/UX-RULES.md)");
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
