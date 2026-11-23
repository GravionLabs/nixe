import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { LogService, LOG_WRITE } from "./log.service";

function fakeConsole() {
  return { error: vi.fn(), warn: vi.fn() };
}

describe("LogService", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it("writes a level and a text", () => {
    new LogService().write("error", "disk full");
    expect(invoke).toHaveBeenCalledWith(LOG_WRITE, { level: "error", message: "disk full" });
  });

  it("cuts a long message", () => {
    new LogService().write("warn", "x".repeat(5000));
    const { message } = invoke.mock.calls[0]![1] as { message: string };
    expect(message.length).toBeLessThan(2100);
  });

  it("forwards console.error and console.warn and still prints them", () => {
    const target = fakeConsole();
    const print = target.error;
    new LogService().start(target);
    target.error("failed", new Error("boom"), { code: 1 });
    target.warn("careful");
    expect(print).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledTimes(2);
    const first = invoke.mock.calls[0]![1] as { level: string; message: string };
    expect(first.level).toBe("error");
    expect(first.message).toContain("failed");
    expect(first.message).toContain("boom");
    expect(first.message).toContain('{"code":1}');
    expect(invoke.mock.calls[1]![1]).toEqual({ level: "warn", message: "careful" });
  });

  it("forwards once however often it starts", () => {
    const target = fakeConsole();
    const log = new LogService();
    log.start(target);
    log.start(target);
    target.error("once");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("survives a log command that rejects or throws", async () => {
    const log = new LogService();
    invoke.mockRejectedValueOnce("no log");
    expect(() => log.write("error", "a")).not.toThrow();
    invoke.mockImplementationOnce(() => {
      throw new Error("no Tauri");
    });
    expect(() => log.write("error", "b")).not.toThrow();
    await Promise.resolve();
  });

  it("does not loop when the log itself prints an error", () => {
    const target = fakeConsole();
    const log = new LogService();
    log.start(target);
    invoke.mockImplementationOnce(() => {
      target.error("inside");
      return Promise.resolve();
    });
    target.error("outer");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
