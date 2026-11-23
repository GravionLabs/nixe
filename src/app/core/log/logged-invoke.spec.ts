import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { LOG_COMMAND } from "./command-log";
import { loggedInvoke } from "./logged-invoke";

describe("loggedInvoke", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("reports a failed command with its name and error text, and rejects with the original", async () => {
    invoke.mockImplementation((command: string) =>
      command === "read_text_file" ? Promise.reject("no such file") : Promise.resolve(),
    );
    await expect(loggedInvoke("read_text_file", { path: "/secret/note.md" })).rejects.toBe(
      "no such file",
    );
    expect(invoke).toHaveBeenCalledWith(LOG_COMMAND, {
      command: "read_text_file",
      error: "no such file",
    });
  });

  it("keeps the original error object", async () => {
    const error = new Error("boom");
    invoke.mockImplementation(() => Promise.reject(error));
    await expect(loggedInvoke("x")).rejects.toBe(error);
  });

  it("sends no arguments of the failed call", async () => {
    invoke.mockImplementation(() => Promise.reject("boom"));
    await loggedInvoke("write_text_file", { content: "my private note" }).catch(() => undefined);
    const logged = invoke.mock.calls.filter(([command]) => command === LOG_COMMAND);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain("my private note");
  });

  it("passes arguments and options on and returns the result", async () => {
    invoke.mockResolvedValue(42);
    await expect(loggedInvoke("answer", { a: 1 }, { headers: {} })).resolves.toBe(42);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("answer", { a: 1 }, { headers: {} });
  });

  it("does not report a failure of the log command itself", async () => {
    invoke.mockImplementation(() => Promise.reject("x"));
    await loggedInvoke(LOG_COMMAND, {}).catch(() => undefined);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("still rejects with the original error when the report fails", async () => {
    invoke.mockImplementation((command: string) =>
      Promise.reject(command === LOG_COMMAND ? "log down" : "orig"),
    );
    await expect(loggedInvoke("a")).rejects.toBe("orig");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
