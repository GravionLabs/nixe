import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(__dirname, "../../../styles.scss"), "utf8");
const component = readFileSync(resolve(__dirname, "viewer.component.ts"), "utf8");

describe("image zoom dialog", () => {
  it("shows a zoom-in cursor on zoomable images", () => {
    expect(styles).toMatch(/img\[data-zoomable\]\s*\{\s*cursor: zoom-in/);
  });

  it("scales the image by width and height, never by a transform", () => {
    const fn = component.match(/private applyDialogZoom\(\): void \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(fn).toContain('"svg, img"');
    expect(fn).toContain("style.width");
    expect(fn).not.toContain("transform");
  });

  it("offers the default app and the file manager for a local image", () => {
    expect(component).toContain("Open with default app");
    expect(component).toContain("revealItemInDir");
  });
});
