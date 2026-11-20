import { describe, expect, it } from "vitest";

import { countText, readingTime } from "./text-stats";

describe("countText", () => {
  it("counts words and characters without whitespace", () => {
    const s = countText("Hello big world\n");
    expect(s).toMatchObject({ words: 3, characters: 13, selection: false });
  });

  it("skips frontmatter", () => {
    expect(countText("---\ntitle: a b c\ntags: [x]\n---\none two").words).toBe(2);
  });

  it("keeps a leading rule that has no closing fence", () => {
    expect(countText("---\none two").words).toBe(3);
  });

  it("skips fenced code blocks, also unclosed ones", () => {
    expect(countText("a\n```ts\nconst x = 1;\n```\nb").words).toBe(2);
    expect(countText("a\n~~~\nx y z\n~~~\nb").words).toBe(2);
    expect(countText("a\n```\nx y z").words).toBe(1);
  });

  it("skips HTML and %% comments, also multi-line", () => {
    expect(countText("a <!-- x y\nz --> b %%hidden words%% c").words).toBe(3);
  });

  it("does not strip frontmatter from a selection", () => {
    const s = countText("---\nfoo\n---\nbar", true);
    expect(s.selection).toBe(true);
    expect(s.words).toBe(4);
  });

  it("handles CRLF", () => {
    expect(countText("---\r\nt: 1\r\n---\r\none two\r\n").words).toBe(2);
  });

  it("is fast on 5000 lines", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `line ${i} with some words in it`).join("\n");
    const start = performance.now();
    const s = countText(text);
    expect(s.words).toBe(5000 * 7);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("readingTime", () => {
  it("rounds to minutes", () => {
    expect(readingTime(countText(Array(450).fill("w").join(" ")))).toBe("Reading time: 2 min");
  });
  it("names a short text", () => {
    expect(readingTime(countText("a few words"))).toBe("Reading time: under a minute");
    expect(readingTime(countText(""))).toBe("Nothing to read");
  });
});
