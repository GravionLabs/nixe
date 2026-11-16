import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(__dirname, "../../scripts/release-checksums.sh");

describe("release-checksums.sh", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sums-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists binary assets but not signatures, latest.json or itself", () => {
    writeFileSync(join(dir, "Nixe_1.0.0_x64.dmg"), "dmg");
    writeFileSync(join(dir, "Nixe_1.0.0_amd64.AppImage"), "appimage");
    writeFileSync(join(dir, "Nixe_1.0.0_amd64.AppImage.sig"), "sig");
    writeFileSync(join(dir, "latest.json"), "{}");
    execFileSync("bash", [script, dir]);
    const lines = readFileSync(join(dir, "SHA256SUMS"), "utf8").trim().split("\n");
    const names = lines.map((l) => l.split(/\s+/).pop());
    expect(names).toEqual(["Nixe_1.0.0_amd64.AppImage", "Nixe_1.0.0_x64.dmg"]);
    // rerun must not include SHA256SUMS itself
    execFileSync("bash", [script, dir]);
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).not.toContain("SHA256SUMS");
  });

  it("fails when there is nothing to checksum", () => {
    writeFileSync(join(dir, "latest.json"), "{}");
    const r = spawnSync("bash", [script, dir]);
    expect(r.status).not.toBe(0);
  });
});
