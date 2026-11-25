/**
 * Builds the browser extension (#499) into `dist/<target>/`: one MV3 package for Chromium and one
 * for Firefox, from the shared `manifest.json`. esbuild bundles the background script. The targets
 * differ only in the manifest: Firefox needs a fixed add-on id (`browser_specific_settings.gecko.id`)
 * and runs the background as `scripts`, Chromium as a `service_worker`.
 *
 * The environment variable `VERSION` (the release workflow: the GitVersion semver of the app)
 * replaces the version of `manifest.json`.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

export const targets = ["chromium", "firefox"] as const;
export type Target = (typeof targets)[number];

/**
 * The add-on id of the Firefox package; it must not change once the extension is on AMO. The native
 * host allows it by name (`ALLOWED_FIREFOX_EXTENSIONS` in `src-tauri/src/native_host.rs`).
 */
export const geckoId = "clipper@nixe.gravionlabs.app";

export type Manifest = Record<string, unknown>;

const background = "background.js";

/** Copied as they are from `src/`. */
const staticFiles = ["popup.html", "popup.css"];

/**
 * The manifest version of a release version. Browsers accept only dot separated numbers, so the
 * pre-release part (`1.2.0-rc.1`) is dropped; Chromium shows the full version as `version_name`.
 */
export function manifestVersion(version: string): string {
  const core = /^(\d+\.\d+\.\d+)(?:[-+]|$)/.exec(version)?.[1];
  if (!core) throw new Error(`not a semantic version: ${version}`);
  return core;
}

/** The manifest of one target, built from the shared base manifest and the release version. */
export function manifestFor(shared: Manifest, target: Target, version?: string): Manifest {
  const base = version ? { ...shared, version: manifestVersion(version) } : shared;
  if (target === "firefox") {
    return {
      ...base,
      background: { scripts: [background], type: "module" },
      browser_specific_settings: { gecko: { id: geckoId } },
    };
  }
  return {
    ...base,
    ...(version && version !== base["version"] ? { version_name: version } : {}),
    background: { service_worker: background, type: "module" },
  };
}

const root = resolve(fileURLToPath(import.meta.url), "../..");

/** Writes every target into `outDir` (default `dist/`), replacing what was there. */
export async function build(
  outDir = join(root, "dist"),
  version = process.env["VERSION"],
): Promise<string[]> {
  const base = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  await rm(outDir, { recursive: true, force: true });
  const dirs: string[] = [];
  for (const target of targets) {
    const dir = join(outDir, target);
    await esbuild({
      entryPoints: {
        background: join(root, "src/background.ts"),
        popup: join(root, "src/popup.ts"),
      },
      outdir: dir,
      bundle: true,
      format: "esm",
      target: target === "firefox" ? "firefox128" : "chrome120",
      logLevel: "warning",
    });
    await mkdir(dir, { recursive: true });
    for (const file of staticFiles) await copyFile(join(root, "src", file), join(dir, file));
    await writeFile(
      join(dir, "manifest.json"),
      `${JSON.stringify(manifestFor(base, target, version), null, 2)}\n`,
    );
    dirs.push(dir);
  }
  return dirs;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const dir of await build()) console.log(dir);
}
