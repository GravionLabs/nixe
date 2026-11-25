import { describe, expect, it } from "vitest";
import {
  buildClipMessage,
  buildLinkMessage,
  describeAnswer,
  describeFailure,
  folderChoices,
  hostMissingText,
  isHostMissing,
  isSavableUrl,
  noteName,
  parseTags,
} from "./messages.ts";

describe("parseTags", () => {
  it("trims, drops # and empty and double tags", () => {
    expect(parseTags(" a, #b ,, a ,c d")).toEqual(["a", "b", "c d"]);
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("buildClipMessage", () => {
  it("holds url, title, html, tags, folder and vault", () => {
    expect(
      buildClipMessage({
        url: "https://e.com/",
        title: " T ",
        html: "<p>x</p>",
        tags: "a, b",
        folder: "Links/Sub",
        vault: "V",
      }),
    ).toEqual({
      type: "clip",
      url: "https://e.com/",
      title: "T",
      html: "<p>x</p>",
      tags: ["a", "b"],
      folder: "Links/Sub",
      vault: "V",
    });
  });

  it("leaves empty fields out", () => {
    expect(buildClipMessage({ url: "https://e.com/", title: " ", html: "", tags: " , " })).toEqual({
      type: "clip",
      url: "https://e.com/",
    });
  });

  it("builds the link message without html", () => {
    expect(buildLinkMessage("https://e.com/a")).toEqual({ type: "clip", url: "https://e.com/a" });
  });
});

describe("answers", () => {
  it("names the note of a saved and of an already saved page", () => {
    expect(noteName("Links/Sub/Example Article.md")).toBe("Example Article");
    expect(describeAnswer({ ok: true, path: "Links/A.md", created: true, vault: "V" })).toEqual({
      kind: "saved",
      text: "Saved: A",
    });
    expect(describeAnswer({ ok: true, path: "Links/A.md", created: false, vault: "V" })).toEqual({
      kind: "already",
      text: "Already saved: A",
    });
  });

  it("shows the error of the host", () => {
    expect(describeAnswer({ ok: false, error: "boom" })).toEqual({ kind: "error", text: "boom" });
  });
});

describe("host missing", () => {
  it.each([
    "Specified native messaging host not found.",
    "Access to the specified native messaging host is forbidden.",
    "No such native application app.gravionlabs.nixe",
  ])("recognizes %s", (text) => {
    expect(isHostMissing(new Error(text))).toBe(true);
    expect(describeFailure(new Error(text))).toEqual({ kind: "error", text: hostMissingText });
  });

  it("reports another error as it is", () => {
    expect(isHostMissing(new Error("Native host has exited."))).toBe(false);
    expect(describeFailure("Native host has exited.").text).toContain("Native host has exited.");
  });
});

describe("folderChoices", () => {
  const vault = (name: string) => ({
    name,
    path: `/${name}`,
    folder: "Links",
    folders: ["Links/Read"],
  });

  it("lists the links folder and its sub folders", () => {
    expect(folderChoices([vault("V")])).toEqual([
      { vault: "V", folder: "Links", label: "Links" },
      { vault: "V", folder: "Links/Read", label: "Links/Read" },
    ]);
  });

  it("prefixes the vault name when there are several", () => {
    expect(folderChoices([vault("A"), vault("B")]).map((f) => f.label)).toEqual([
      "A: Links",
      "A: Links/Read",
      "B: Links",
      "B: Links/Read",
    ]);
  });
});

describe("isSavableUrl", () => {
  it("accepts web pages only", () => {
    expect(isSavableUrl("https://e.com")).toBe(true);
    expect(isSavableUrl("http://e.com")).toBe(true);
    expect(isSavableUrl("chrome://settings")).toBe(false);
    expect(isSavableUrl(undefined)).toBe(false);
  });
});
