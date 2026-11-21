import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "../../core/git/history.service";
import {
  dayLabel,
  describeEntry,
  groupByDay,
  hasSeveralAuthors,
  relativeTime,
} from "./timeline-format";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const secs = (ms: number) => ms / 1000;
const NOW = at(2026, 11, 21);

describe("dayLabel", () => {
  it("names today, yesterday, the weekday within a week, then the date", () => {
    expect(dayLabel(secs(at(2026, 11, 21, 1)), NOW)).toBe("Today");
    expect(dayLabel(secs(at(2026, 11, 20, 23)), NOW)).toBe("Yesterday");
    expect(dayLabel(secs(at(2026, 11, 18)), NOW)).toBe("Wednesday");
    expect(dayLabel(secs(at(2026, 11, 14)), NOW)).toBe("14 Nov 2026");
  });
});

describe("relativeTime", () => {
  it("counts in the largest unit", () => {
    expect(relativeTime(secs(NOW - 20_000), NOW)).toBe("just now");
    expect(relativeTime(secs(NOW - 5 * 60_000), NOW)).toBe("5 minutes ago");
    expect(relativeTime(secs(NOW - 2 * 3_600_000), NOW)).toBe("2 hours ago");
    expect(relativeTime(secs(NOW - 3_600_000), NOW)).toBe("1 hour ago");
    expect(relativeTime(secs(NOW - 3 * 86_400_000), NOW)).toBe("3 days ago");
  });
});

describe("describeEntry", () => {
  const base = { author: "A", time: 1, path: "a.md" };
  it("names automatic saves and operations in plain words", () => {
    expect(
      describeEntry({ ...base, id: "1", message: "vault backup: 2026-01-01 10:00:00" }),
    ).toEqual({
      icon: null,
      text: "Automatic save",
    });
    expect(
      describeEntry({
        ...base,
        id: "1",
        message: "merge: a.md -> b.md, links in 2 notes",
        operation: "merge",
      }).text,
    ).toBe("Merged: a.md → b.md");
    expect(describeEntry({ ...base, id: "1", message: "x", operation: "restore" }).text).toBe(
      "Restored",
    );
    expect(describeEntry({ ...base, id: "1", message: "my words" }).text).toBe("my words");
  });
});

describe("groupByDay and authors", () => {
  it("puts the uncommitted state first and starts a group per day", () => {
    const e = (id: string | null, ms: number, author = "A"): TimelineEntry => ({
      id,
      author,
      time: secs(ms),
      message: "m",
      path: "a.md",
    });
    const groups = groupByDay(
      [e(null, 0), e("1", NOW), e("2", NOW - 1000), e("3", NOW - 2 * 86_400_000)],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.entries.length])).toEqual([
      ["Now", 1],
      ["Today", 2],
      ["Thursday", 1],
    ]);
    expect(hasSeveralAuthors([e("1", NOW), e("2", NOW)])).toBe(false);
    expect(hasSeveralAuthors([e("1", NOW), e("2", NOW, "B")])).toBe(true);
  });
});
