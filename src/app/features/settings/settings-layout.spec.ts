import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "settings.component.css"), "utf8");

describe("settings layout", () => {
  it("lets the label take only what the control leaves (#457)", () => {
    // With the default flex basis a long description squeezed the access token column to 66 px.
    expect(css).toMatch(/\.label\s*\{[^}]*flex: 1 1 0;[^}]*min-width: 0/);
  });

  it("limits the search field and the sections to a readable width (#544)", () => {
    expect(css).toMatch(/\.search,\s*section\s*\{[^}]*max-width: 760px/);
  });

  it("keeps the scrollbar at the page edge: .content has no maximum width (#544)", () => {
    expect(css).not.toMatch(/\.content\s*\{[^}]*max-width/);
  });
});
