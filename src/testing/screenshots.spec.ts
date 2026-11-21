import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const views = pathToFileURL(resolve(root, "scripts/screenshots/views.mjs")).href;

interface View {
  name: string;
  run: unknown;
}

describe("scripts/screenshots", () => {
  it("lists the editor, the file tree with backlinks and the search", async () => {
    const mod = (await import(/* @vite-ignore */ views)) as {
      VIEWS: View[];
      VIEWPORT: unknown;
    };
    const names = mod.VIEWS.map((v) => v.name);
    expect(names).toEqual(expect.arrayContaining(["editor", "backlinks", "search"]));
    expect(new Set(names).size).toBe(names.length);
    for (const view of mod.VIEWS) expect(view.run).toBeTypeOf("function");
  });

  it("exports the step helpers of the e2e tests", async () => {
    const mod = (await import(/* @vite-ignore */ views)) as Record<string, unknown>;
    for (const step of [
      "ready",
      "openNote",
      "openFolder",
      "openView",
      "searchFor",
      "showBacklinks",
    ])
      expect(mod[step], step).toBeTypeOf("function");
  });

  it("fails an unknown view name before it starts a browser", () => {
    const run = spawnSync("node", ["scripts/screenshots.mjs", "nope", "--out", "tmp/none"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown view: nope");
  });

  it("opens the demo server in the light and the dark theme", async () => {
    const href = pathToFileURL(resolve(root, "scripts/browser/playwright.mjs")).href;
    const mod = (await import(/* @vite-ignore */ href)) as {
      THEMES: string[];
      TARGETS: { demo: { name: string; port: number } };
      withBrowser: unknown;
    };
    expect(mod.THEMES).toEqual(["light", "dark"]);
    expect(mod.TARGETS.demo).toEqual({ name: "nixe:serve:demo", port: 1422 });
    expect(mod.withBrowser).toBeTypeOf("function");
  });

  it("leaves a picture in tmp/shots for a failed view, also for a missing demo answer", () => {
    const source = readFileSync(resolve(root, "scripts/screenshots.mjs"), "utf8");
    expect(source).toContain("no demo answer for");
    expect(source).toContain("tmp/shots/failed-");
    expect(source.indexOf("no demo answer for")).toBeLessThan(source.indexOf("catch (err)"));
  });

  it("registers the pnpm script", async () => {
    const pkg = (await import("../../package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["screenshots"]).toBe("node scripts/screenshots.mjs");
  });
});
