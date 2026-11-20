import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const doc = readFileSync(resolve(root, "docs/cutover.md"), "utf8");

describe("docs/cutover.md", () => {
  it.each([
    "Capture",
    "Daily note",
    "Template",
    "Link",
    "Rename",
    "Search",
    "Attach an image",
    "Sync",
  ])("lists the %s workflow with a check box", (workflow) => {
    expect(doc).toMatch(new RegExp(`^\\| ${workflow} \\|.*\\| \\[ \\] \\|$`, "m"));
  });

  it("explains the week, the git diff check and when the cutover is done", () => {
    expect(doc).toContain("git diff");
    expect(doc).toContain(".obsidian/");
    expect(doc).toContain("no blocking gap is open");
  });

  it("is linked from the docs map and links only to existing files", () => {
    expect(readFileSync(resolve(root, "docs/README.md"), "utf8")).toContain("(cutover.md)");
    for (const [, target] of doc.matchAll(/\]\(([^)#:]+\.md)\)/g)) {
      expect(existsSync(resolve(root, "docs", target)), target).toBe(true);
    }
  });
});
