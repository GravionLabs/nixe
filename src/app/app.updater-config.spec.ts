import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("updater configuration", () => {
  it("points at the latest GitHub release and has a public key", () => {
    const { plugins } = read("src-tauri/tauri.conf.json");
    expect(plugins.updater.endpoints).toEqual([
      "https://github.com/GravionLabs/nixe/releases/latest/download/latest.json",
    ]);
    expect(plugins.updater.pubkey).toBeTruthy();
  });

  it("creates updater artifacts only in the release config", () => {
    expect(read("src-tauri/tauri.conf.json").bundle.createUpdaterArtifacts).toBeUndefined();
    expect(read("src-tauri/tauri.release.conf.json").bundle.createUpdaterArtifacts).toBe(true);
  });

  it("passes the signing key to the release build only on a publish", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ env.PUBLISH == 'true' && secrets.TAURI_SIGNING_PRIVATE_KEY || '' }}",
    );
    expect(workflow).toContain("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
    expect(workflow).toContain("--config src-tauri/tauri.release.conf.json");
  });
});
