import { describe, expect, it, vi } from "vitest";
import { errorText, installCommandLog, LOG_COMMAND } from "./command-log";

function fake(invoke: (command: string, args?: unknown) => Promise<unknown>) {
  const spy = vi.fn(invoke);
  return { target: { __TAURI_INTERNALS__: { invoke: spy } }, spy };
}

describe("installCommandLog", () => {
  it("does nothing without Tauri", () => {
    expect(installCommandLog({})).toBe(false);
  });

  it("reports a failed command with its name and error text, and still rejects", async () => {
    const { target, spy } = fake((command) =>
      command === "read_text_file" ? Promise.reject("no such file") : Promise.resolve(),
    );
    expect(installCommandLog(target)).toBe(true);
    await expect(
      target.__TAURI_INTERNALS__.invoke("read_text_file", { path: "/secret/note.md" }),
    ).rejects.toBe("no such file");
    expect(spy).toHaveBeenCalledWith(LOG_COMMAND, {
      command: "read_text_file",
      error: "no such file",
    });
  });

  it("sends no arguments of the failed call", async () => {
    const { target, spy } = fake(() => Promise.reject("boom"));
    installCommandLog(target);
    await target.__TAURI_INTERNALS__
      .invoke("write_text_file", { content: "my private note" })
      .catch(() => undefined);
    const logged = spy.mock.calls.filter(([command]) => command === LOG_COMMAND);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain("my private note");
  });

  it("leaves a successful command alone", async () => {
    const { target, spy } = fake(() => Promise.resolve(42));
    installCommandLog(target);
    await expect(target.__TAURI_INTERNALS__.invoke("answer")).resolves.toBe(42);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not report a failure of the log command itself", async () => {
    const { target, spy } = fake(() => Promise.reject("x"));
    installCommandLog(target);
    await target.__TAURI_INTERNALS__.invoke(LOG_COMMAND, {}).catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("errorText", () => {
  it("turns any rejection into text", () => {
    expect(errorText("a")).toBe("a");
    expect(errorText(new Error("b"))).toBe("b");
    expect(errorText({ code: 1 })).toBe('{"code":1}');
  });
});
