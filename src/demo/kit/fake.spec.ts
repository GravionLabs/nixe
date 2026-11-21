// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnansweredCommandError } from "./backend";
import { createFakeBackend } from "./fake";

beforeEach(() => {
  delete window.__demoFailures;
  delete window.__demoCalls;
  delete window.__demo;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createFakeBackend", () => {
  it("answers a scripted command with a value or a function of the arguments", async () => {
    const backend = createFakeBackend({ notes: ["a"], echo: (args) => args?.["x"] });
    await expect(backend.invoke("notes")).resolves.toEqual(["a"]);
    await expect(backend.invoke("echo", { x: 3 })).resolves.toBe(3);
  });

  it("fails a command nobody set up, by name, and tells the runner", async () => {
    const backend = createFakeBackend({ notes: [] });
    await expect(backend.invoke("write_text_file")).rejects.toBeInstanceOf(UnansweredCommandError);
    expect(window.__demoFailures).toEqual(["write_text_file"]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("write_text_file"));
  });

  it("records the calls with their arguments", async () => {
    const backend = createFakeBackend({ write_text_file: null, notes: [] });
    await backend.invoke("write_text_file", { path: "/a.md", text: "hi" });
    await backend.invoke("notes");
    expect(backend.callsOf("write_text_file")).toEqual([
      { command: "write_text_file", args: { path: "/a.md", text: "hi" }, order: 1 },
    ]);
    expect(backend.callsOf().map((c) => c.command)).toEqual(["write_text_file", "notes"]);
  });

  it("replaces an answer at runtime through window.__demo", async () => {
    const backend = createFakeBackend({ notes: ["a"] }).expose();
    window.__demo!.answer("notes", ["b"]);
    await expect(backend.invoke("notes")).resolves.toEqual(["b"]);
    expect(window.__demo!.calls("notes")).toHaveLength(1);
  });

  it("pushes an event to the listeners of the app through window.__demo", () => {
    const backend = createFakeBackend().expose();
    const seen: unknown[] = [];
    backend.listen("file-changed", (p) => seen.push(p));
    window.__demo!.emit("file-changed", { path: "/a.md" });
    expect(seen).toEqual([{ payload: { path: "/a.md" } }]);
  });
});
