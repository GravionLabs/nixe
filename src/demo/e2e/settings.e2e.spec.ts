// @vitest-environment jsdom
// The settings pages of the demo (#403): the settings file, the workspaces and the terminal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadApp } from "./harness";

vi.mock("@tauri-apps/api/core", () => import("./mock"));
vi.mock("@tauri-apps/api/event", () => import("./mock"));

let app: ReturnType<typeof loadApp>;
beforeEach(async () => {
  app = loadApp();
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("Settings of the demo", () => {
  it("keeps the settings the page writes", async () => {
    expect(JSON.parse((await app.backend.readAppSettings())!).lastFolder).toBe("/demo/Notes");
    await app.backend.writeAppSettings('{"terminalEnabled":true}');
    expect(await app.backend.readAppSettings()).toBe('{"terminalEnabled":true}');
  });

  it("answers the vault settings of the pages", async () => {
    expect(await app.backend.linkFormat()).toBe("shortest");
    expect(await app.backend.newNoteLocation()).toEqual({ location: "root", folder: "" });
    expect(await app.backend.dailyNotesConfig()).toMatchObject({ folder: "Daily" });
    expect(await app.backend.vaultHealth([])).toEqual({
      brokenLinks: [],
      orphans: [],
      duplicates: [],
      unusedAttachments: [],
    });
  });

  it("saves, loads and deletes a workspace", async () => {
    expect(await app.backend.workspaceList()).toEqual([]);
    const base = { name: "Work", roots: [] };
    const added = await app.backend.workspaceAddRoot(base, "/demo/Wiki");
    expect(added.roots).toEqual([{ path: "/demo/Wiki", name: "Wiki", kind: "folder" }]);
    await app.backend.workspaceSave(added);
    expect(await app.backend.workspaceList()).toEqual(["Work"]);
    expect(await app.backend.workspaceLoad("Work")).toEqual(added);
    await app.backend.workspaceDelete("Work");
    expect(await app.backend.workspaceList()).toEqual([]);
    await expect(app.backend.workspaceLoad("Work")).rejects.toContain("No such workspace");
  });

  it("keeps the own location variables of the device (#495)", async () => {
    expect((await app.backend.locationsList()).variables).toEqual({ Books: "/demo/Books" });
    const added = await app.backend.locationsSet("Papers", "/demo/Papers", null);
    expect(added.variables).toEqual({ Books: "/demo/Books", Papers: "/demo/Papers" });
    const renamed = await app.backend.locationsSet("Library", "/demo/Lib", "Books");
    expect(renamed.variables).toEqual({ Library: "/demo/Lib", Papers: "/demo/Papers" });
    await expect(app.backend.locationsSet("Home", "/x", null)).rejects.toContain("built-in");
    await expect(app.backend.locationsSet("Papers", "/x", null)).rejects.toContain("exists");
    await expect(app.backend.locationsSet("A", "rel", null)).rejects.toContain("absolute");
    expect((await app.backend.locationsRemove("Papers")).variables).toEqual({
      Library: "/demo/Lib",
    });
    expect((await app.backend.locationsChooseOnedrive("/demo/OneDrive-Work")).onedrive).toBe(
      "/demo/OneDrive-Work",
    );
    expect((await app.backend.locationsChooseOnedrive(null)).onedrive).toBeUndefined();
  });

  it("searches and resolves links over a workspace", async () => {
    const roots = [{ path: "/demo/Notes", name: "Notes" }];
    expect((await app.backend.searchWorkspace(roots, "backlinks"))[0]).toMatchObject({
      path: "Ideas.md",
      root: "Notes",
      rootPath: "/demo/Notes",
    });
    expect((await app.backend.workspaceNotes(roots)).map((n) => n.root)).toContain("Notes");
    expect(
      await app.backend.workspaceResolveLinks({ name: "W", roots: [] }, "Home.md", [
        "Ideas",
        "Missing",
      ]),
    ).toEqual([{ root: "/demo/Notes", path: "Ideas.md" }, null]);
  });

  it("runs a terminal session that prints and echoes", async () => {
    const id = await app.terminal.open(24, 80);
    const out: string[] = [];
    const exited = vi.fn();
    await app.terminal.onOutput(id, (bytes) => out.push(text(bytes)));
    await app.terminal.onExit(id, exited);
    await app.terminal.attach(id);
    await Promise.resolve();
    expect(out.join("")).toBe("demo@nixe:~/Notes$ ");
    await app.terminal.write(id, "ls\r");
    expect(out.join("")).toContain("ls\r\nThis is the terminal of the demo");
    await app.terminal.resize(id, 30, 100);
    await app.terminal.checkPreset("claude");
    await app.terminal.close(id);
    expect(exited).toHaveBeenCalledOnce();
  });

  it("gives every terminal its own session", async () => {
    const first = await app.terminal.open(24, 80);
    expect(await app.terminal.open(24, 80)).not.toBe(first);
  });

  it("calls no command nobody answered", () => {
    expect(window.__demoFailures).toBeUndefined();
  });
});
