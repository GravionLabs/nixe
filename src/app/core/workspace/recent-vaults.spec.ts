import { describe, expect, it } from "vitest";

import { addRecent, pruneStates, removeRecent, sanitizeRecent, sanitizeStates } from "./recent-vaults";

describe("recent vaults", () => {
  it("puts the newest first and moves a reopened vault to the front", () => {
    expect(addRecent(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
    expect(addRecent(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("keeps the last five", () => {
    const list = ["/1", "/2", "/3", "/4", "/5"];
    expect(addRecent(list, "/6")).toEqual(["/6", "/1", "/2", "/3", "/4"]);
  });

  it("removes a vault", () => {
    expect(removeRecent(["/a", "/b"], "/a")).toEqual(["/b"]);
    expect(removeRecent(["/a"], "/x")).toEqual(["/a"]);
  });

  it("prunes the states of vaults that left the list", () => {
    const state = { note: null, sidebar: true, backlinks: false, outline: false };
    expect(pruneStates({ "/a": state, "/b": state }, ["/b"])).toEqual({ "/b": state });
  });

  it("sanitizes stored data", () => {
    expect(sanitizeRecent(["/a", 3, "/a", "", "/b"])).toEqual(["/a", "/b"]);
    expect(sanitizeRecent("nope")).toEqual([]);
    expect(sanitizeRecent(["/1", "/2", "/3", "/4", "/5", "/6"])).toHaveLength(5);
    expect(sanitizeStates(null)).toEqual({});
    expect(sanitizeStates({ "/a": { note: "/a/x.md", outline: true }, "/b": 4 })).toEqual({
      "/a": { note: "/a/x.md", sidebar: true, backlinks: false, outline: true },
    });
  });
});
