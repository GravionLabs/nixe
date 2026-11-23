import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|html)$/.test(name) && !name.endsWith(".spec.ts") ? [path] : [];
  });
}

describe("Tauri internals (#520)", () => {
  it("no module under src/ assigns to __TAURI_INTERNALS__", () => {
    const assigns = /__TAURI_INTERNALS__[\w.[\]"']*\s*=(?!=)/;
    const offenders = sources("src").filter((file) => assigns.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the main entry does not touch __TAURI_INTERNALS__", () => {
    expect(readFileSync("src/main.ts", "utf8")).not.toContain("__TAURI_INTERNALS__");
  });
});
