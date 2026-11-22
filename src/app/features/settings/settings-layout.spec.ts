import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "settings.component.css"), "utf8");

describe("settings layout", () => {
  it("lets the label take only what the control leaves (#457)", () => {
    // With the default flex basis a long description squeezed the access token column to 66 px.
    expect(css).toMatch(/\.label\s*\{[^}]*flex: 1 1 0;[^}]*min-width: 0/);
  });
});
