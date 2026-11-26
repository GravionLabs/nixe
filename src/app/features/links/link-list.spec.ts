import { describe, expect, it } from "vitest";

import type { BaseCell, BaseResult } from "../../core/file/backend";
import {
  collectionOf,
  collections,
  filterLinks,
  linkItems,
  linkTags,
  statusOf,
  webAddress,
  type LinkFilter,
  type LinkItem,
} from "./link-list";

const ALL: LinkFilter = { collection: null, tag: null, status: null };

const link = (path: string, change: Partial<LinkItem> = {}): LinkItem => ({
  path,
  title: path,
  site: "",
  tags: [],
  saved: "",
  status: "unread",
  url: null,
  collection: "",
  cover: null,
  ...change,
});

const LINKS = [
  link("a", { collection: "Recipes", tags: ["Food"], status: "read" }),
  link("b", { collection: "Recipes/Cakes", tags: ["food", "sweet"] }),
  link("c", { collection: "Recipes old", tags: ["later"] }),
  link("d"),
];

const paths = (filter: Partial<LinkFilter>) =>
  filterLinks(LINKS, { ...ALL, ...filter }).map((l) => l.path);

describe("filterLinks", () => {
  it("keeps every link without a filter", () => {
    expect(paths({})).toEqual(["a", "b", "c", "d"]);
    expect(filterLinks([], ALL)).toEqual([]);
  });

  it("keeps a collection with its sub folders, not a folder with a like name", () => {
    expect(paths({ collection: "Recipes" })).toEqual(["a", "b"]);
    expect(paths({ collection: "Recipes/Cakes" })).toEqual(["b"]);
    expect(paths({ collection: "Nope" })).toEqual([]);
  });

  it("filters by tag without regard to case, and by status", () => {
    expect(paths({ tag: "FOOD" })).toEqual(["a", "b"]);
    expect(paths({ status: "unread" })).toEqual(["b", "c", "d"]);
    expect(paths({ status: "read" })).toEqual(["a"]);
  });

  it("applies all filters together", () => {
    expect(paths({ collection: "Recipes", tag: "food", status: "unread" })).toEqual(["b"]);
  });

  it("lists the collections with their parents and each tag once", () => {
    expect(collections(LINKS)).toEqual(
      ["Recipes", "Recipes old", "Recipes/Cakes"].sort((a, b) => a.localeCompare(b)),
    );
    expect(collections([link("x", { collection: "A/B" })])).toEqual(["A", "A/B"]);
    expect(linkTags(LINKS)).toEqual(["Food", "later", "sweet"]);
  });
});

describe("the values of a link", () => {
  it("reads only `read` as read", () => {
    expect(statusOf("read")).toBe("read");
    expect(statusOf(" Read ")).toBe("read");
    for (const other of ["unread", "", "done"]) expect(statusOf(other)).toBe("unread");
  });

  it("accepts web addresses only", () => {
    expect(webAddress(" https://example.com/a ")).toBe("https://example.com/a");
    expect(webAddress("HTTP://example.com")).toBe("HTTP://example.com");
    for (const other of ["", "file:///etc/passwd", "javascript:alert(1)", "https://", "a b"])
      expect(webAddress(other)).toBeNull();
  });

  it("names the collection by the folder below the links folder", () => {
    expect(collectionOf("Links/A.md", "Links")).toBe("");
    expect(collectionOf("Links/Recipes/A.md", "Links")).toBe("Recipes");
    expect(collectionOf("Web/Saved/Recipes/A.md", "Web/Saved")).toBe("Recipes");
    expect(collectionOf("Projects/A.md", "Links")).toBe("Projects");
    expect(collectionOf("Linkshelf/A.md", "Links")).toBe("Linkshelf");
    expect(collectionOf("A.md", "Links")).toBe("");
  });
});

describe("linkItems", () => {
  const ids = ["file.name", "title", "site", "tags", "saved", "status", "url"];
  const result = (path: string, cells: BaseCell[]): BaseResult => ({
    view: "Links",
    columns: ids.map((id) => ({ id, label: id })),
    rows: [{ path, cells, cover: null }],
    grouping: null,
    unsupported: [],
  });
  const text = (value: string): BaseCell => ({ type: "text", value });
  const none: BaseCell = { type: null, value: null };

  it("reads the properties of a row", () => {
    const cells: BaseCell[] = [
      text("A"),
      text("An article"),
      text("example.com"),
      { type: "list", value: ["#reading", "web"] },
      text("2026-11-20T09:30:00+01:00"),
      text("read"),
      text("https://example.com/a"),
    ];
    expect(linkItems(result("Links/Web/A.md", cells), "Links")).toEqual([
      {
        path: "Links/Web/A.md",
        title: "An article",
        site: "example.com",
        tags: ["reading", "web"],
        saved: "2026-11-20T09:30:00+01:00",
        status: "read",
        url: "https://example.com/a",
        collection: "Web",
        cover: null,
      },
    ]);
  });

  it("falls back for missing properties", () => {
    const cells = [text("Bare"), none, none, none, none, none, none];
    expect(linkItems(result("Links/Bare.md", cells), "Links")[0]).toMatchObject({
      title: "Bare",
      site: "",
      tags: [],
      saved: "",
      status: "unread",
      url: null,
    });
  });
});
