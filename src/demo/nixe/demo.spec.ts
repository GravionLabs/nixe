// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { LOG_COMMAND } from "../../app/core/log/command-log";
import { HOME_NOTE, NOTES, TIME, VAULT } from "./data";
import { createNixeDemo } from "./demo";
import { EXCLUDED } from "./excluded";
import { DemoVault } from "./vault";
import linksBase from "../../app/features/links/links-base.json";

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

  it("answers a base with the notes and their properties", () => {
    const result = vault().baseQuery(
      "filters: x\nviews:\n  - type: table\n    order: [file.name, note.status, formula.f]\n",
      null,
      null,
    );
    expect(result.columns.map((c) => c.id)).toEqual(["file.name", "note.status"]);
    expect(result.rows.find((r) => r.path === "Projects/Nixe.md")?.cells).toEqual([
      { type: "text", value: "Nixe" },
      { type: "text", value: "active" },
    ]);
    expect(result.unsupported).toEqual(["filters"]);
    expect(() => vault().baseQuery("views: [{ type: cards }]", null, null)).toThrow(
      "no table view",
    );
  });

  it("lists the views of a base and answers the chosen one, sorted by a clicked column", () => {
    const source =
      "views:\n  - { type: cards, name: C }\n  - { type: table, name: T, order: [file.name] }\n";
    expect(vault().baseViews(source)).toEqual([
      { name: "C", type: "cards" },
      { name: "T", type: "table" },
    ]);
    const names = vault()
      .baseQuery(source, 1, { property: "file.name", direction: "DESC" })
      .rows.map((r) => String(r.cells[0]!.value));
    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a)));
    expect(() => vault().baseQuery(source, 0, null)).toThrow("no table view");
  });

  it("answers the base of the Links view with the link notes only", () => {
    const v = vault();
    v.write(
      `${v.root}/Links/A.md`,
      "---\ntype: link\nstatus: unread\nimage: https://example.com/a.png\n---\n",
    );
    const result = v.baseQuery(JSON.stringify(linksBase), null, null);
    expect(result.rows.map((r) => r.path)).toEqual(["Links/A.md"]);
    expect(result.rows[0]!.cover).toEqual({ type: "url", value: "https://example.com/a.png" });
    expect(result.unsupported).toEqual([]);
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

  it("answers the commands the editor asks for on start", async () => {
    const { backend } = createNixeDemo();
    expect(await backend.invoke("conflict_pair", { path: HOME_NOTE })).toBeNull();
    expect(await backend.invoke<string[]>("notes_list")).toContain("Home");
    expect(window.__demoFailures).toBeUndefined();
  });

  it("writes a note and reads it back", async () => {
    const { backend } = createNixeDemo();
    await backend.invoke("write_text_file", { path: HOME_NOTE, content: "# Changed" });
    expect(await backend.invoke("read_text_file", { path: HOME_NOTE })).toBe("# Changed");
  });

  it("answers read_epub for a book in the vault or a root and refuses the rest", async () => {
    const { backend } = createNixeDemo();
    const bytes = await backend.invoke<number[]>("read_epub", {
      path: `${VAULT}/Books/a.epub`,
      roots: [],
    });
    expect(bytes.slice(0, 2)).toEqual([0x50, 0x4b]);
    // The demo reader shows the book of the fixtures (#487).
    expect(bytes).toEqual([...readFileSync("fixtures/books/sample.epub")]);
    await backend.invoke("read_epub", { path: "/other/b.EPUB", roots: ["/other/"] });
    await expect(
      backend.invoke("read_epub", { path: "/elsewhere/c.epub", roots: [VAULT] }),
    ).rejects.toMatch("outside");
    await expect(
      backend.invoke("read_epub", { path: `${VAULT}/Home.md`, roots: [] }),
    ).rejects.toMatch("not an EPUB");
  });

  it("fails a command it does not know and names it", async () => {
    const { backend } = createNixeDemo();
    await expect(backend.invoke("brand_new_command")).rejects.toThrow("brand_new_command");
    expect(window.__demoFailures).toEqual(["brand_new_command"]);
  });
});

/** The commands the app invokes in the typed wrappers of the Rust core: `invoke<T>("name", …)`. */
function commandsOf(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const found = [...source.matchAll(/\binvoke(?:<.*?>)?\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!);
  // Every call of `invoke` must have given a name: a type that the pattern cannot read fails here.
  const calls = [...source.matchAll(/\binvoke\s*[<(]/g)].length;
  expect(found, `${file}: a call of invoke has no readable command name`).toHaveLength(calls);
  return found;
}

describe("the commands of the app", () => {
  const app = [
    ...commandsOf("../../app/core/file/backend.ts"),
    ...commandsOf("../../app/core/terminal/terminal-backend.ts"),
  ];
  const answered = new Set(createNixeDemo().backend.commands());

  it("finds the commands of the wrappers", () => {
    expect(app.length).toBeGreaterThan(100);
    expect(app).toContain("git_vault_status");
    expect(app).toContain("terminal_open");
    expect(app).toContain("workspace_add_root");
  });

  it("answers the command that loggedInvoke sends for a failed command (#542)", () => {
    expect(answered.has(LOG_COMMAND)).toBe(true);
  });

  it("answers every command or lists it as excluded with a reason", () => {
    const missing = app.filter((c) => !answered.has(c) && !(c in EXCLUDED));
    expect(
      missing,
      `answer these in demo.ts or list them in excluded.ts: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("lists no command that is answered or that the app no longer has", () => {
    for (const [command, reason] of Object.entries(EXCLUDED)) {
      expect(app, `${command} is not a command of the app`).toContain(command);
      expect(answered.has(command), `${command} is answered and excluded`).toBe(false);
      expect(reason.trim(), `${command} has no reason`).not.toBe("");
    }
  });

  it("fails an excluded command with its name", async () => {
    const { backend } = createNixeDemo();
    await expect(backend.invoke("rename_path", { from: "a", to: "b" })).rejects.toThrow(
      "rename_path",
    );
  });
});
