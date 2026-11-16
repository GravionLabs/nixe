import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AutoSaver,
  ExternalChangeTracker,
  SAVE_IDLE_MS,
  clampLine,
  inlineTokens,
  nodeClass,
  tokenAt,
  viewerTopLine,
} from "./editor-core";

describe("AutoSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes the latest text once after one second without changes", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const saver = new AutoSaver({ write });
    saver.change("a");
    await vi.advanceTimersByTimeAsync(SAVE_IDLE_MS - 1);
    saver.change("ab");
    await vi.advanceTimersByTimeAsync(SAVE_IDLE_MS - 1);
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("ab");
    expect(saver.dirty).toBe(false);
  });

  it("flush writes at once and cancels the timer", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const saver = new AutoSaver({ write });
    saver.change("x");
    expect(saver.dirty).toBe(true);
    await saver.flush();
    expect(write).toHaveBeenCalledWith("x");
    await vi.advanceTimersByTimeAsync(SAVE_IDLE_MS * 2);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("flush without a change writes nothing", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await new AutoSaver({ write }).flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("never overlaps writes and writes the newest text last", async () => {
    const order: string[] = [];
    let release!: () => void;
    const write = vi.fn(async (text: string) => {
      order.push(`start ${text}`);
      if (text === "a") await new Promise<void>((r) => (release = r));
      order.push(`end ${text}`);
    });
    const saver = new AutoSaver({ write });
    saver.change("a");
    const first = saver.flush();
    await Promise.resolve();
    saver.change("b");
    const second = saver.flush();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("keeps the text dirty and reports when the write fails", async () => {
    const onError = vi.fn();
    const write = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
    const saver = new AutoSaver({ write, onError });
    saver.change("t");
    await saver.flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(saver.dirty).toBe(true);
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith("t");
    expect(saver.dirty).toBe(false);
  });

  it("a newer change wins over a failed older write", async () => {
    const write = vi.fn(async (text: string) => {
      if (text === "old") throw new Error("x");
    });
    const saver = new AutoSaver({ write, onError: () => undefined });
    saver.change("old");
    const running = saver.flush();
    saver.change("new");
    await running;
    await saver.flush();
    expect(write).toHaveBeenLastCalledWith("new");
  });

  it("writes nothing while held and writes the pending text on release", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const saver = new AutoSaver({ write });
    saver.hold(true);
    saver.change("mine");
    await vi.advanceTimersByTimeAsync(SAVE_IDLE_MS * 2);
    await saver.flush();
    expect(write).not.toHaveBeenCalled();
    expect(saver.dirty).toBe(true);
    saver.hold(false);
    await saver.flush();
    expect(write).toHaveBeenCalledWith("mine");
  });

  it("discard drops the pending text", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const saver = new AutoSaver({ write });
    saver.change("gone");
    saver.discard();
    await vi.advanceTimersByTimeAsync(SAVE_IDLE_MS * 2);
    await saver.flush();
    expect(write).not.toHaveBeenCalled();
    expect(saver.dirty).toBe(false);
  });
});

describe("ExternalChangeTracker", () => {
  it("ignores the text the editor opened with and the app's own writes", () => {
    const tracker = new ExternalChangeTracker("opened");
    expect(tracker.classify("opened", false)).toBe("ignore");
    tracker.willWrite("saved 1");
    tracker.willWrite("saved 2");
    // the event of the first write arrives after the second write started
    expect(tracker.classify("saved 1", true)).toBe("ignore");
    expect(tracker.classify("saved 2", true)).toBe("ignore");
  });

  it("reloads a foreign change when there are no unsaved changes", () => {
    const tracker = new ExternalChangeTracker("a");
    expect(tracker.classify("b", false)).toBe("reload");
  });

  it("asks when a foreign change meets unsaved changes", () => {
    const tracker = new ExternalChangeTracker("a");
    expect(tracker.classify("b", true)).toBe("conflict");
  });

  it("accepting the disk text makes it the shared one", () => {
    const tracker = new ExternalChangeTracker("a");
    tracker.accept("b");
    expect(tracker.classify("b", true)).toBe("ignore");
  });

  it("forgets old writes beyond a few", () => {
    const tracker = new ExternalChangeTracker("0");
    for (const t of ["1", "2", "3", "4", "5"]) tracker.willWrite(t);
    expect(tracker.classify("0", false)).toBe("reload");
    expect(tracker.classify("5", false)).toBe("ignore");
  });
});

describe("scroll mapping", () => {
  const blocks = [
    { line: 0, top: 0, bottom: 100 },
    { line: 4, top: 100, bottom: 300 },
    { line: 9, top: 300, bottom: 400 },
  ];

  it("takes the first block that ends below the top as 1-based line", () => {
    expect(viewerTopLine(blocks, 0)).toBe(1);
    expect(viewerTopLine(blocks, 100)).toBe(5);
    expect(viewerTopLine(blocks, 250)).toBe(5);
    expect(viewerTopLine(blocks, 300)).toBe(10);
  });

  it("falls back to the last block when scrolled past the end, and to null without blocks", () => {
    expect(viewerTopLine(blocks, 9999)).toBe(10);
    expect(viewerTopLine([], 0)).toBeNull();
  });

  it("clamps a line into the document", () => {
    expect(clampLine(0, 10)).toBe(1);
    expect(clampLine(99, 10)).toBe(10);
    expect(clampLine(4.7, 10)).toBe(4);
    expect(clampLine(3, 0)).toBe(1);
  });
});

describe("inlineTokens", () => {
  it("finds wikilinks with alias, heading and block", () => {
    const line = "see [[Note]] and [[folder/Other#Head|alias]] ok";
    expect(inlineTokens(line).map((t) => [t.kind, t.value])).toEqual([
      ["wikilink", "Note"],
      ["wikilink", "folder/Other#Head|alias"],
    ]);
  });

  it("reports offsets relative to the line", () => {
    const [t] = inlineTokens("ab [[X]]");
    expect([t.from, t.to]).toEqual([3, 8]);
  });

  it("finds tags like the renderer: nested, unicode, not digit-only, after whitespace", () => {
    const tokens = inlineTokens("#todo a/b #über #123 x#no (#in) #a-");
    expect(tokens.map((t) => t.value)).toEqual(["todo", "über", "in", "a"]);
  });

  it("keeps nested tags whole and drops trailing separators", () => {
    expect(inlineTokens("#a/b/c.").map((t) => t.value)).toEqual(["a/b/c"]);
    expect(inlineTokens("#a//b")).toEqual([]);
  });

  it("skips code spans", () => {
    expect(inlineTokens("`[[x]]` `#tag` [[y]]").map((t) => t.value)).toEqual(["y"]);
  });

  it("does not read a heading marker as a tag", () => {
    expect(inlineTokens("# Heading")).toEqual([]);
    expect(inlineTokens("## Heading")).toEqual([]);
  });

  it("finds the token under an offset", () => {
    const line = "go [[Note]] now";
    expect(tokenAt(line, 5)?.value).toBe("Note");
    expect(tokenAt(line, 1)).toBeNull();
    expect(tokenAt("#t [[n]]", 1, "wikilink")).toBeNull();
  });
});

describe("nodeClass", () => {
  it("maps Markdown nodes to classes", () => {
    expect(nodeClass("ATXHeading2")).toBe("cm-md-h2");
    expect(nodeClass("SetextHeading1")).toBe("cm-md-h1");
    expect(nodeClass("StrongEmphasis")).toBe("cm-md-strong");
    expect(nodeClass("Emphasis")).toBe("cm-md-em");
    expect(nodeClass("InlineCode")).toBe("cm-md-code");
    expect(nodeClass("EmphasisMark")).toBe("cm-md-syntax");
    expect(nodeClass("Paragraph")).toBeNull();
  });
});
