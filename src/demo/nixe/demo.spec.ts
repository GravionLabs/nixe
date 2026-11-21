// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { HOME_NOTE, NOTES, TIME, VAULT } from "./data";
import { createNixeDemo } from "./demo";
import { DemoVault } from "./vault";

beforeEach(() => {
  delete window.__demoCalls;
  delete window.__demoFailures;
});

describe("DemoVault", () => {
  const vault = () => new DemoVault(VAULT, NOTES, Date.parse(TIME));

  it("lists a folder with a fixed modification time", () => {
    const entries = vault().listDir(VAULT);
    expect(entries.map((e) => e.name).sort()).toEqual(["Daily", "Home.md", "Ideas.md", "Projects"]);
    expect(new Set(entries.map((e) => e.modified))).toEqual(new Set([Date.parse(TIME)]));
  });

  it("gives the same listing in two runs", () => {
    expect(vault().listDir(VAULT)).toEqual(vault().listDir(VAULT));
  });

  it("reads and writes a note in memory", () => {
    const v = vault();
    v.write(`${VAULT}/New.md`, "# New");
    expect(v.read(`${VAULT}/New.md`)).toBe("# New");
    expect(v.relativeFiles()).toContain("New.md");
    expect(() => v.read(`${VAULT}/Nope.md`)).toThrow("No such file");
  });

  it("finds the backlinks of a note with their line and context", () => {
    const links = vault().backlinks("Projects/Helix.md");
    expect(links.map((l) => l.source).sort()).toEqual(["Home.md", "Projects/Nixe.md"]);
    expect(links[0]!.context).toContain("[[Projects/Helix]]");
  });

  it("resolves a link by name and by path", () => {
    const v = vault();
    expect(v.resolve("Home")).toBe("Home.md");
    expect(v.resolve("Projects/Nixe")).toBe("Projects/Nixe.md");
    expect(v.resolve("Missing")).toBeNull();
  });

  it("counts the tags once per note", () => {
    const tags = vault().tags();
    expect(tags.find((t) => t.tag === "project")).toEqual({ tag: "project", count: 2 });
  });

  it("searches the text and marks the match", () => {
    const hits = vault().search("backlinks");
    expect(hits.map((h) => h.path)).toEqual(["Ideas.md"]);
    expect(hits[0]!.snippets[0]!.text).toContain("\u0001Backlinks\u0002");
    expect(vault().search("  ")).toEqual([]);
  });
});

describe("the demo backend of Nixe", () => {
  it("starts the app in the demo vault", async () => {
    const { backend } = createNixeDemo();
    const settings = await backend.invoke<string>("read_app_settings");
    expect(JSON.parse(settings).lastFolder).toBe(VAULT);
    expect(await backend.invoke("is_dir", { path: VAULT })).toBe(true);
  });

  it("answers the file tree, the index status and the side panels", async () => {
    const { backend } = createNixeDemo();
    const entries = await backend.invoke<{ name: string }[]>("list_dir", { path: VAULT });
    expect(entries).toHaveLength(4);
    expect(await backend.invoke("index_status")).toMatchObject({
      state: "ready",
      total: Object.keys(NOTES).length,
    });
    expect(await backend.invoke<unknown[]>("backlinks", { path: "Ideas.md" })).not.toHaveLength(0);
    expect(await backend.invoke<unknown[]>("tags")).not.toHaveLength(0);
    expect(await backend.invoke<unknown[]>("search_notes", { query: "demo" })).not.toHaveLength(0);
  });

  it("writes a note and reads it back", async () => {
    const { backend } = createNixeDemo();
    await backend.invoke("write_text_file", { path: HOME_NOTE, content: "# Changed" });
    expect(await backend.invoke("read_text_file", { path: HOME_NOTE })).toBe("# Changed");
  });

  it("fails a command it does not know and names it", async () => {
    const { backend } = createNixeDemo();
    await expect(backend.invoke("brand_new_command")).rejects.toThrow("brand_new_command");
    expect(window.__demoFailures).toEqual(["brand_new_command"]);
  });
});
