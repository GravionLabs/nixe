import { describe, expect, it } from "vitest";

import { importNotice } from "./import-notice";

describe("importNotice", () => {
  it("says nothing when nothing was imported", () => {
    expect(importNotice({ written: [], sources: [], warnings: [] })).toBeNull();
  });

  it("names the files that were imported and the written ones", () => {
    const text = importNotice({
      written: [".nixe/config.json", ".nixe/bookmarks.json"],
      sources: [".obsidian/app.json", ".obsidian/bookmarks.json"],
      warnings: [],
    });
    expect(text).toContain(".obsidian/app.json, .obsidian/bookmarks.json");
    expect(text).toContain(".nixe/config.json, .nixe/bookmarks.json");
    expect(text).toContain("next commit");
    expect(text).not.toContain("Warning");
  });

  it("makes a failure a warning", () => {
    const text = importNotice({
      written: [],
      sources: [],
      warnings: [".nixe/config.json was not written: read-only"],
    });
    expect(text).toContain("Warning");
    expect(text).toContain("read-only");
    expect(text).not.toContain("Imported");
  });

  it("reports both the import and a warning of another file", () => {
    const text = importNotice({
      written: [".nixe/config.json"],
      sources: [".obsidian/templates.json"],
      warnings: [".obsidian/app.json is invalid JSON"],
    });
    expect(text).toContain("Imported");
    expect(text).toContain("Warning");
  });
});
