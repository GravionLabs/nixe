import { spawnSync } from "node:child_process";
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

  it("registers the pnpm script", async () => {
    const pkg = (await import("../../package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["screenshots"]).toBe("node scripts/screenshots.mjs");
  });
});
