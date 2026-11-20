import { describe, expect, it } from "vitest";

import { breadcrumb } from "./breadcrumb";

const labels = (path: string | null, root: string | null) =>
  breadcrumb(path, root).map((c) => c.label);

describe("breadcrumb", () => {
  it("is empty without a note", () => {
    expect(breadcrumb(null, "/v")).toEqual([]);
  });

  it("shows the folders and the note relative to the vault", () => {
    const crumbs = breadcrumb("/v/backend/file-watching.md", "/v");
    expect(crumbs).toEqual([
      { label: "backend", dir: "/v/backend", kind: "folder" },
      { label: "file-watching.md", dir: null, kind: "note" },
    ]);
  });

  it("shows a note at the vault root as the file name only", () => {
    expect(labels("/v/a.md", "/v")).toEqual(["a.md"]);
  });

  it("shows the file name outside a vault or outside its folder", () => {
    expect(labels("/x/y/a.md", null)).toEqual(["a.md"]);
    expect(labels("/other/y/a.md", "/v")).toEqual(["a.md"]);
    expect(labels("/vault2/a.md", "/vault")).toEqual(["a.md"]);
  });

  it("keeps three folders as they are", () => {
    expect(labels("/v/a/b/c/n.md", "/v")).toEqual(["a", "b", "c", "n.md"]);
  });

  it("shortens the middle of a deep path and keeps the note", () => {
    const crumbs = breadcrumb("/v/a/b/c/d/e/n.md", "/v");
    expect(crumbs.map((c) => c.label)).toEqual(["a", "…", "d", "e", "n.md"]);
    expect(crumbs.map((c) => c.dir)).toEqual(["/v/a", null, "/v/a/b/c/d", "/v/a/b/c/d/e", null]);
    expect(crumbs[1].kind).toBe("ellipsis");
    expect(crumbs[4].kind).toBe("note");
  });
});
