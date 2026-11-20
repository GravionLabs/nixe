import { describe, expect, it } from "vitest";

import { dailyPath, neighborDaily, parseDailyPath } from "./daily-core";

const day = new Date(2026, 2, 2, 14, 7);

describe("dailyPath", () => {
  it("uses YYYY-MM-DD in the vault root by default", () => {
    expect(dailyPath(day, { folder: "", format: "" })).toBe("2026-03-02.md");
  });

  it("puts the note in the folder", () => {
    expect(dailyPath(day, { folder: "/Journal/", format: "YYYY-MM-DD" })).toBe(
      "Journal/2026-03-02.md",
    );
  });

  it("builds nested formats", () => {
    expect(dailyPath(day, { folder: "", format: "YYYY/MM/YYYY-MM-DD" })).toBe(
      "2026/03/2026-03-02.md",
    );
    expect(dailyPath(day, { folder: "Daily", format: "YYYY/MMMM/DD dddd" })).toBe(
      "Daily/2026/March/02 Monday.md",
    );
    expect(dailyPath(day, { folder: "Daily", format: "YYYY\\MM\\DD" })).toBe("Daily/2026/03/02.md");
  });

  it("refuses paths that leave the vault", () => {
    expect(() => dailyPath(day, { folder: "../x", format: "YYYY" })).toThrow(
      "not a path in the vault",
    );
    expect(() => dailyPath(day, { folder: "", format: "YYYY//DD" })).toThrow(
      "not a path in the vault",
    );
  });
});

describe("parseDailyPath", () => {
  const nested = { folder: "Journal", format: "YYYY/MM/YYYY-MM-DD" };

  it("reads the date of a nested path", () => {
    expect(parseDailyPath("Journal/2026/03/2026-03-02.md", nested)).toEqual(new Date(2026, 2, 2));
  });

  it("rejects other folders, names and impossible dates", () => {
    expect(parseDailyPath("Other/2026/03/2026-03-02.md", nested)).toBeNull();
    expect(parseDailyPath("Journal/2026/03/notes.md", nested)).toBeNull();
    expect(parseDailyPath("Journal/2026/02/2026-02-30.md", nested)).toBeNull();
    expect(parseDailyPath("Journal/2026/03/2026-03-02.png", nested)).toBeNull();
  });

  it("reads month names and ordinals; other tokens match anything", () => {
    expect(parseDailyPath("March 2nd, 2026.md", { folder: "", format: "MMMM Do, YYYY" })).toEqual(
      new Date(2026, 2, 2),
    );
    expect(
      parseDailyPath("2026-03-02 Monday.md", { folder: "", format: "YYYY-MM-DD dddd" }),
    ).toEqual(new Date(2026, 2, 2));
  });

  it("cannot read a format without year, month and day", () => {
    expect(parseDailyPath("2026-03.md", { folder: "", format: "YYYY-MM" })).toBeNull();
  });
});

describe("neighborDaily", () => {
  const config = { folder: "", format: "YYYY/MM/YYYY-MM-DD" };
  const files = [
    "2026/02/2026-02-27.md",
    "2026/03/2026-03-02.md",
    "2026/03/2026-03-05.md",
    "Note.md",
    "2026/03/2026-03-09.md",
  ];

  it("finds the nearest earlier and later note", () => {
    expect(neighborDaily(files, new Date(2026, 2, 5, 18), -1, config)).toBe(
      "2026/03/2026-03-02.md",
    );
    expect(neighborDaily(files, new Date(2026, 2, 5, 18), 1, config)).toBe("2026/03/2026-03-09.md");
    expect(neighborDaily(files, new Date(2026, 2, 3), 1, config)).toBe("2026/03/2026-03-05.md");
  });

  it("is null at the ends", () => {
    expect(neighborDaily(files, new Date(2026, 1, 27), -1, config)).toBeNull();
    expect(neighborDaily(files, new Date(2026, 2, 9), 1, config)).toBeNull();
  });
});
