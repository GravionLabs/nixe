// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { backend } from "../file/backend";
import { FoldStateService } from "./fold-state.service";

describe("FoldStateService", () => {
  const read = vi.spyOn(backend, "readFolds");
  const write = vi.spyOn(backend, "writeFolds");

  beforeEach(() => {
    vi.useFakeTimers();
    read.mockReset();
    write.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it("reads the stored lines of a note", async () => {
    read.mockResolvedValue('{"/v/a.md":[4,2]}');
    const s = new FoldStateService();
    expect(s.peek("/v/a.md")).toBeNull();
    expect(await s.linesOf("/v/a.md")).toEqual([2, 4]);
    expect(await s.linesOf("/v/b.md")).toEqual([]);
    expect(s.peek("/v/a.md")).toEqual([2, 4]);
  });

  it("writes the changed state after a pause, all notes together", async () => {
    read.mockResolvedValue('{"/v/a.md":[1]}');
    const s = new FoldStateService();
    s.set("/v/b.md", [5, 3]);
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({ "/v/a.md": [1], "/v/b.md": [3, 5] });
  });

  it("drops a note without folds and writes once for quick changes", async () => {
    read.mockResolvedValue('{"/v/a.md":[1]}');
    const s = new FoldStateService();
    s.set("/v/a.md", [2]);
    s.set("/v/a.md", []);
    await vi.advanceTimersByTimeAsync(600);
    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]![0])).toEqual({});
  });

  it("flush writes at once", async () => {
    read.mockResolvedValue(null);
    const s = new FoldStateService();
    s.set("/v/a.md", [2]);
    await vi.advanceTimersByTimeAsync(0);
    await s.flush();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("never overwrites a file that could not be read", async () => {
    read.mockRejectedValue("denied");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = new FoldStateService();
    s.set("/v/a.md", [2]);
    await vi.advanceTimersByTimeAsync(600);
    expect(write).not.toHaveBeenCalled();
    expect(await s.linesOf("/v/a.md")).toEqual([2]);
  });
});
