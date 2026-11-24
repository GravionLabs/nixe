import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, geckoId, manifestFor, type Manifest } from "./build.ts";

const base: Manifest = { manifest_version: 3, name: "Nixe", version: "0.1.0" };

describe("manifestFor", () => {
  it("gives Firefox the add-on id and a background script", () => {
    expect(manifestFor(base, "firefox")).toEqual({
      ...base,
      background: { scripts: ["background.js"], type: "module" },
      browser_specific_settings: { gecko: { id: geckoId } },
    });
  });

  it("gives Chromium a service worker and no Firefox keys", () => {
    const manifest = manifestFor(base, "chromium");

    expect(manifest["background"]).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest).not.toHaveProperty("browser_specific_settings");
  });
});

describe("build", () => {
  let out: string;

  beforeAll(async () => {
    out = await mkdtemp(join(tmpdir(), "nixe-extension-"));
    await build(out);
  });

  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it("writes one MV3 package per browser", async () => {
    expect((await readdir(out)).sort()).toEqual(["chromium", "firefox"]);
    for (const target of ["chromium", "firefox"]) {
      expect((await readdir(join(out, target))).sort()).toEqual([
        "background.js",
        "manifest.json",
        "popup.css",
        "popup.html",
        "popup.js",
      ]);
      const manifest = JSON.parse(await readFile(join(out, target, "manifest.json"), "utf8"));
      expect(manifest.manifest_version).toBe(3);
    }
  });

  it("writes the Firefox add-on id only into the Firefox manifest", async () => {
    const read = async (target: string) =>
      JSON.parse(await readFile(join(out, target, "manifest.json"), "utf8"));

    expect((await read("firefox")).browser_specific_settings.gecko.id).toBe(geckoId);
    expect(await read("chromium")).not.toHaveProperty("browser_specific_settings");
  });
});
