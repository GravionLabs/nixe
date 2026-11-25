import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build, geckoId, manifestFor, manifestVersion, type Manifest } from "./build.ts";

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

describe("release version", () => {
  it("keeps only the numbers of a pre-release version", () => {
    expect(manifestVersion("1.15.0")).toBe("1.15.0");
    expect(manifestVersion("1.15.0-rc.3")).toBe("1.15.0");
    expect(() => manifestVersion("v1.15")).toThrow("not a semantic version");
  });

  it("replaces the manifest version of both targets", () => {
    for (const target of ["chromium", "firefox"] as const) {
      expect(manifestFor(base, target, "1.15.0")["version"]).toBe("1.15.0");
      expect(manifestFor(base, target, "1.15.0")).not.toHaveProperty("version_name");
    }
  });

  it("shows the pre-release version as version_name in Chromium only", () => {
    expect(manifestFor(base, "chromium", "1.15.0-rc.3")).toMatchObject({
      version: "1.15.0",
      version_name: "1.15.0-rc.3",
    });
    expect(manifestFor(base, "firefox", "1.15.0-rc.3")).not.toHaveProperty("version_name");
  });

  it("builds the packages with the release version", async () => {
    const out = await mkdtemp(join(tmpdir(), "nixe-extension-"));
    try {
      await build(out, "2.3.4");
      for (const target of ["chromium", "firefox"]) {
        const manifest = JSON.parse(await readFile(join(out, target, "manifest.json"), "utf8"));
        expect(manifest.version).toBe("2.3.4");
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
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
