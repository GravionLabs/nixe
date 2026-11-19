import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The helix components (HxTabBar, HxButton, ...) are unstyled without the stylesheet of helix-ui: tokens.css
// carries only the colours, styles.css the component rules. #222: the tab bar rendered as plain stacked text.
describe("global styles in angular.json", () => {
  const angular = JSON.parse(readFileSync(resolve(__dirname, "../../angular.json"), "utf8"));
  const styles: string[] = angular.projects.nixe.architect.build.options.styles;

  it("loads the helix tokens, the helix-ui components and the desktop frame", () => {
    expect(styles).toContain("node_modules/@gravionlabs/helix-ui/tokens.css");
    expect(styles).toContain("node_modules/@gravionlabs/helix-ui/styles.css");
    expect(styles).toContain("node_modules/@gravionlabs/helix-desktop/styles.css");
  });

  it("loads the tokens before the components", () => {
    expect(styles.indexOf("node_modules/@gravionlabs/helix-ui/tokens.css")).toBeLessThan(
      styles.indexOf("node_modules/@gravionlabs/helix-ui/styles.css"),
    );
  });

  it("ships a stylesheet with the tab bar rules", () => {
    const css = readFileSync(resolve(__dirname, "../../node_modules/@gravionlabs/helix-ui/styles.css"), "utf8");
    expect(css).toContain(".hx-tab-bar");
  });
});
