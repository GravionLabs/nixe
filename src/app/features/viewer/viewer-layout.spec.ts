import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const viewer = readFileSync(resolve(__dirname, "viewer.component.css"), "utf8");
const editor = readFileSync(resolve(__dirname, "../editor/editor-extensions.ts"), "utf8");

describe("note layout", () => {
  it("centers the viewer content with a rule that outranks the github markdown margin", () => {
    const rule = viewer.match(/:host article\.markdown-body\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("margin: 0 auto");
    expect(rule).toContain("max-width: 980px");
    expect(rule).toContain("box-sizing: border-box");
  });

  it("keeps the padding of a narrow pane", () => {
    expect(viewer).toMatch(/@media \(max-width: 700px\)[\s\S]*article\.markdown-body\s*\{\s*padding: 20px 16px 60px/);
  });

  it("uses the same width and centering in the editor", () => {
    expect(editor).toMatch(/"\.cm-content": \{[^}]*maxWidth: "980px", margin: "0 auto"/);
  });
});
