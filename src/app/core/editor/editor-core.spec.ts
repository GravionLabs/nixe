import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AutoSaver,
  ExternalChangeTracker,
  OWN_WRITE_WINDOW_MS,
  SAVE_IDLE_MS,
  UNDO_RELOAD_MS,
  changedRange,
  clampLine,
  discardedByReload,
  inlineTokens,
  nodeClass,
  toCrlf,
  linkAt,
  linkTokens,
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
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
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

  it("exposes the pending text", () => {
    const saver = new AutoSaver({ write: vi.fn() });
    expect(saver.pendingText).toBeNull();
    saver.change("p");
    expect(saver.pendingText).toBe("p");
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

describe("AutoSaver onDirtyChange", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports each flip once: change, write, held, failed write", async () => {
    const flips: boolean[] = [];
    const write = vi.fn().mockResolvedValue(undefined);
    const saver = new AutoSaver({ write, onDirtyChange: (d) => flips.push(d) });
    saver.change("a");
    saver.change("b");
    expect(flips).toEqual([true]);
    await saver.flush();
    expect(flips).toEqual([true, false]);
    saver.hold(true);
    saver.change("c");
    await saver.flush();
    expect(flips).toEqual([true, false, true]);
    saver.discard();
    expect(flips).toEqual([true, false, true, false]);
  });

  it("is dirty again after a failed write", async () => {
    const flips: boolean[] = [];
    const write = vi.fn().mockRejectedValue(new Error("full"));
    const saver = new AutoSaver({
      write,
      onError: () => undefined,
      onDirtyChange: (d) => flips.push(d),
    });
    saver.change("t");
    await saver.flush();
    expect(flips).toEqual([true, false, true]);
  });
});

describe("ExternalChangeTracker", () => {
  it("ignores the opened text and writes in flight", () => {
    const tracker = new ExternalChangeTracker("opened");
    expect(tracker.classify("opened", false)).toBe("ignore");
    tracker.willWrite("w1");
    tracker.willWrite("w2");
    expect(tracker.classify("w1", true)).toBe("ignore");
    expect(tracker.classify("w2", true)).toBe("ignore");
  });

  it("ignores a late event of an earlier write for a short while", () => {
    let t = 0;
    const tracker = new ExternalChangeTracker("a", () => t);
    tracker.willWrite("b");
    tracker.written("b");
    tracker.willWrite("c");
    tracker.written("c");
    t = OWN_WRITE_WINDOW_MS - 1;
    expect(tracker.classify("b", false)).toBe("ignore");
    t = OWN_WRITE_WINDOW_MS + 1;
    expect(tracker.classify("b", false)).toBe("reload");
  });

  it("treats a restore of an older text as a foreign change", () => {
    let t = 0;
    const tracker = new ExternalChangeTracker("A", () => t);
    tracker.willWrite("B");
    tracker.written("B");
    t = 60_000;
    expect(tracker.classify("A", false)).toBe("reload");
    expect(tracker.classify("A", true)).toBe("conflict");
  });

  it("a failed write is no longer ignored", () => {
    const tracker = new ExternalChangeTracker("a");
    tracker.willWrite("b");
    tracker.failed("b");
    expect(tracker.classify("b", false)).toBe("reload");
  });

  it("asks when a foreign change meets unsaved changes", () => {
    expect(new ExternalChangeTracker("a").classify("b", true)).toBe("conflict");
  });

  it("accepting the disk text makes it the shared one", () => {
    const tracker = new ExternalChangeTracker("a");
    tracker.accept("b");
    expect(tracker.classify("b", true)).toBe("ignore");
  });

  it("converts line endings to CRLF without doubling", () => {
    expect(toCrlf("a\nb\r\nc")).toBe("a\r\nb\r\nc");
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

describe("changedRange", () => {
  const apply = (from: string, to: string) => {
    const r = changedRange(from, to);
    return r ? from.slice(0, r.from) + r.insert + from.slice(r.to) : from;
  };

  it("is null for equal texts", () => {
    expect(changedRange("same", "same")).toBeNull();
  });

  it("replaces only the middle", () => {
    expect(changedRange("hello world", "hello brave world")).toEqual({
      from: 6,
      to: 6,
      insert: "brave ",
    });
    expect(changedRange("abcd", "ad")).toEqual({ from: 1, to: 3, insert: "" });
  });

  it("turns one text into the other", () => {
    for (const [a, b] of [
      ["", "x"],
      ["x", ""],
      ["aaa", "aa"],
      ["aa", "aaa"],
      ["abc", "xyz"],
      ["a\nb", "a\nc\nb"],
    ]) {
      expect(apply(a, b)).toBe(b);
    }
  });

  it("does not split a surrogate pair", () => {
    const r = changedRange("a😀b", "a😁b")!;
    expect(r).toEqual({ from: 1, to: 3, insert: "😁" });
  });
});

describe("discardedByReload", () => {
  it("is the editor text that the reload replaced", () => {
    expect(discardedByReload("my edit", "disk")).toBe("my edit");
  });

  it("is null when the reload loses nothing", () => {
    expect(discardedByReload("same", "same")).toBeNull();
  });

  it("offers the undo for 10 s", () => {
    expect(UNDO_RELOAD_MS).toBe(10_000);
  });

  it("puts the discarded text back with a change from the reloaded text", () => {
    const range = changedRange("disk v2\n", "disk v1\nmy edit")!;
    const restored = "disk v2\n".slice(0, range.from) + range.insert + "disk v2\n".slice(range.to);
    expect(restored).toBe("disk v1\nmy edit");
  });
});

describe("linkTokens", () => {
  it("finds wikilinks, Markdown links and bare URLs", () => {
    const line = "[[A#h]] [Fly](https://x.app/a/) and https://y.app/b.";
    expect(linkTokens(line).map((l) => [l.kind, l.target])).toEqual([
      ["wikilink", "A#h"],
      ["markdown", "https://x.app/a/"],
      ["url", "https://y.app/b"],
    ]);
  });

  it("reads relative hrefs, angle brackets and titles", () => {
    expect(linkTokens("[n](../Other-note.md#top)")[0].target).toBe("../Other-note.md#top");
    expect(linkTokens('[n](<a b.md> "t")')[0].target).toBe("a b.md");
  });

  it("does not take a URL inside a Markdown link twice, code, images or a closing parenthesis", () => {
    expect(linkTokens("[x](https://a.b/c)")).toHaveLength(1);
    expect(linkTokens("`https://a.b` ![i](p.png)")).toHaveLength(0);
    expect(linkTokens("(see https://a.b/c)")[0].target).toBe("https://a.b/c");
    expect(linkTokens("https://a.b/(c)")[0].target).toBe("https://a.b/(c)");
  });

  it("linkAt finds the link under an offset", () => {
    const line = "go https://a.b/c now";
    expect(linkAt(line, 5)?.kind).toBe("url");
    expect(linkAt(line, 1)).toBeNull();
  });
});
