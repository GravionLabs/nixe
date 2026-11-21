import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const features = resolve(__dirname, "..");
const read = (file: string) => readFileSync(resolve(features, file), "utf8");
const hostRule = (source: string) => source.match(/:host\s*\{([^}]*)\}/)?.[1] ?? "";

const views = {
  files: read("sidebar/sidebar.component.css"),
  search: read("search/search.component.css"),
  git: read("git/git.component.css"),
  history: read("history/history.component.css"),
  bookmarks: read("bookmarks/bookmarks.component.ts"),
};

describe("sidebar layout", () => {
  for (const [name, source] of Object.entries(views)) {
    it(`the ${name} view takes the height of the sidebar slot`, () => {
      const rule = hostRule(source);
      expect(rule).toContain("height: 100%");
      expect(rule).toContain("min-height: 0");
    });
  }

  it("lets the file tree take the rest below the header and scroll inside", () => {
    const rule = views.files.match(/\.tree\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toContain("flex: 1");
    expect(rule).toContain("overflow: auto");
  });

  it("takes the drop and the context menu of the root on the tree area", () => {
    const html = read("sidebar/sidebar.component.html");
    expect(html).toMatch(/class="tree"[^>]*[\s\S]*?\(contextmenu\)="openMenu\(\$event, null\)"/);
    expect(html).toContain('(drop)="drop($event, null)"');
  });
});
