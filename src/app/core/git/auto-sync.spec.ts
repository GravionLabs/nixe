import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutoSyncScheduler, clampMinutes } from "./auto-sync";

describe("clampMinutes", () => {
  it("rounds and limits the interval", () => {
    expect(clampMinutes(0)).toBe(1);
    expect(clampMinutes(2.6)).toBe(3);
    expect(clampMinutes(99999)).toBe(1440);
    expect(clampMinutes(NaN)).toBe(10);
  });
});

describe("AutoSyncScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (run = vi.fn().mockResolvedValue(undefined)) => ({
    run,
    s: new AutoSyncScheduler(run, 5000, () => Date.now()),
  });

  it("syncs on every interval tick", async () => {
    const { s, run } = make();
    s.start(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("starts no interval when none is given", async () => {
    const { s, run } = make();
    s.start(null);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run).not.toHaveBeenCalled();
    s.request();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits until the editor has been idle", async () => {
    const { s, run } = make();
    s.start(null);
    s.activity();
    s.request();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    s.activity();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("never runs two syncs at once and merges requests into one follow-up", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { s } = make(run);
    s.start(null);
    s.request();
    s.request();
    s.request();
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps going after a failed run", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined);
    const { s } = make(run);
    s.start(null);
    s.request();
    await vi.advanceTimersByTimeAsync(0);
    s.request();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops waiting requests and timers on stop", async () => {
    const { s, run } = make();
    s.start(60_000);
    s.activity();
    s.request();
    s.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(run).not.toHaveBeenCalled();
    s.request();
    expect(run).not.toHaveBeenCalled();
  });
});
