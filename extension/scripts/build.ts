/**
 * Builds the browser extension (#499) into `dist/<target>/`: one MV3 package for Chromium and one
 * for Firefox, from the shared `manifest.json`. esbuild bundles the background script. The targets
 * differ only in the manifest: Firefox needs a fixed add-on id (`browser_specific_settings.gecko.id`)
 * and runs the background as `scripts`, Chromium as a `service_worker`.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

export const targets = ["chromium", "firefox"] as const;
export type Target = (typeof targets)[number];

/** The add-on id of the Firefox package; it must not change once the extension is on AMO. */
export const geckoId = "extension@nixe.app";

export type Manifest = Record<string, unknown>;

const background = "background.js";

/** The manifest of one target, built from the shared base manifest. */
export function manifestFor(base: Manifest, target: Target): Manifest {
  if (target === "firefox") {
    return {
      ...base,
      background: { scripts: [background], type: "module" },
      browser_specific_settings: { gecko: { id: geckoId } },
    };
  }
  return { ...base, background: { service_worker: background, type: "module" } };
}

const root = resolve(fileURLToPath(import.meta.url), "../..");

/** Writes every target into `outDir` (default `dist/`), replacing what was there. */
export async function build(outDir = join(root, "dist")): Promise<string[]> {
  const base = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  await rm(outDir, { recursive: true, force: true });
  const dirs: string[] = [];
  for (const target of targets) {
    const dir = join(outDir, target);
    await esbuild({
      entryPoints: [join(root, "src/background.ts")],
      outfile: join(dir, background),
      bundle: true,
      format: "esm",
      target: target === "firefox" ? "firefox128" : "chrome120",
      logLevel: "warning",
    });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "manifest.json"),
      `${JSON.stringify(manifestFor(base, target), null, 2)}\n`,
    );
    dirs.push(dir);
  }
  return dirs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const dir of await build()) console.log(dir);
}
