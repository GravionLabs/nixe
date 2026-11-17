import { describe, expect, it } from "vitest";

import { applyChanges, expandTemplate, formatMoment, insertTemplate } from "./template-core";

// Wednesday 7 May 2025, 14:05:09.042 local time.
const NOW = new Date(2025, 4, 7, 14, 5, 9, 42);
const ctx = { title: "Weekly review", now: NOW };

describe("formatMoment", () => {
  it.each([
    ["YYYY-MM-DD", "2025-05-07"],
    ["YY", "25"],
    ["M/D", "5/7"],
    ["MMMM", "May"],
    ["MMM", "May"],
    ["Do", "7th"],
    ["dddd", "Wednesday"],
    ["ddd", "Wed"],
    ["dd", "We"],
    ["d", "3"],
    ["E", "3"],
    ["HH:mm:ss", "14:05:09"],
    ["H:m:s", "14:5:9"],
    ["hh:mm A", "02:05 PM"],
    ["h a", "2 pm"],
    ["SSS", "042"],
    ["Q", "2"],
    ["DDD", "127"],
    ["DDDD", "127"],
    ["WW", "19"],
    ["W", "19"],
    ["X", String(Math.floor(NOW.getTime() / 1000))],
    ["x", String(NOW.getTime())],
  ])("%s -> %s", (format, expected) => {
    expect(formatMoment(NOW, format)).toBe(expected);
  });

  it("keeps text in brackets and unknown characters", () => {
    expect(formatMoment(NOW, "[Week] W, YYYY [at] HH:mm")).toBe("Week 19, 2025 at 14:05");
    expect(formatMoment(NOW, "YYYY/MM/DD - dddd")).toBe("2025/05/07 - Wednesday");
  });

  it("writes the ordinal suffixes", () => {
    const day = (d: number) => formatMoment(new Date(2025, 0, d), "Do");
    expect([day(1), day(2), day(3), day(4), day(11), day(12), day(13), day(21), day(22), day(23)]).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd",
    ]);
  });

  it("uses the 12-hour clock around noon and midnight", () => {
    expect(formatMoment(new Date(2025, 0, 1, 0, 0), "h A")).toBe("12 AM");
    expect(formatMoment(new Date(2025, 0, 1, 12, 0), "h A")).toBe("12 PM");
    expect(formatMoment(new Date(2025, 0, 1, 0, 0), "k")).toBe("24");
  });

  it("writes the offset of the time zone", () => {
    expect(formatMoment(NOW, "Z")).toMatch(/^[+-]\d\d:\d\d$/);
    expect(formatMoment(NOW, "ZZ")).toMatch(/^[+-]\d{4}$/);
  });
});

describe("expandTemplate", () => {
  it("replaces title, date and time with Obsidian's default formats", () => {
    expect(expandTemplate("# {{title}}\n{{date}} {{time}}", ctx)).toBe("# Weekly review\n2025-05-07 14:05");
  });

  it("replaces date and time with a format", () => {
    expect(expandTemplate("{{date:dddd, MMMM Do YYYY}} / {{time:hh:mm A}} / {{date:[W]W}}", ctx)).toBe(
      "Wednesday, May 7th 2025 / 02:05 PM / W19",
    );
  });

  it("allows spaces inside the braces and replaces every occurrence", () => {
    expect(expandTemplate("{{ title }} {{title}} {{ date : YYYY }}", ctx)).toBe("Weekly review Weekly review 2025");
  });

  it("falls back to the default format when the format is empty", () => {
    expect(expandTemplate("{{date:}}", ctx)).toBe("2025-05-07");
  });

  it("leaves other double braces alone", () => {
    expect(expandTemplate("{{unknown}} {{#each}} ${x}", ctx)).toBe("{{unknown}} {{#each}} ${x}");
  });

  it("does not interpret `$` patterns of the title", () => {
    expect(expandTemplate("{{title}}", { ...ctx, title: "Cost $& $1" })).toBe("Cost $& $1");
  });
});

// A template like the ones in an Obsidian vault.
const VAULT_TEMPLATE = `---
created: {{date:YYYY-MM-DD}}T{{time:HH:mm}}
tags: [daily, review]
title: "{{title}}"
---
# {{title}}
{{date:dddd, MMMM Do}}

## Notes
`;

function run(note: string, cursor: number, template: string) {
  const expanded = expandTemplate(template, ctx);
  const result = insertTemplate(note, cursor, expanded);
  const text = applyChanges(note, result.changes);
  return { text, cursor: result.cursor };
}

describe("insertTemplate", () => {
  it("inserts a template without frontmatter at the cursor", () => {
    const { text, cursor } = run("Hello world", 5, "-- {{title}} --");
    expect(text).toBe("Hello-- Weekly review -- world");
    expect(cursor).toBe(5 + "-- Weekly review --".length);
  });

  it("puts the frontmatter of the template into a note without one", () => {
    const { text, cursor } = run("", 0, VAULT_TEMPLATE);
    expect(text).toBe(
      `---
created: 2025-05-07T14:05
tags:
  - daily
  - review
title: Weekly review
---
# Weekly review
Wednesday, May 7th

## Notes
`,
    );
    expect(cursor).toBe(text.length);
  });

  it("keeps the frontmatter out of the body and the body below the existing frontmatter", () => {
    const note = "---\nstatus: open\n---\nText";
    const { text } = run(note, 0, VAULT_TEMPLATE);
    const body = text.slice(text.indexOf("---\n", 4) + 4);
    expect(body.startsWith("# Weekly review\n")).toBe(true);
    expect(body.endsWith("Text")).toBe(true);
    expect(text.match(/^---$/gm)).toHaveLength(2);
  });

  it("merges into the existing frontmatter: the note wins, empty values and new keys come from the template", () => {
    const note = "---\n# my comment\nstatus: open\ncreated:\ntags: [mine, review]\n---\nText";
    const { text } = run(note, note.length, VAULT_TEMPLATE);
    const front = text.slice(0, text.indexOf("\n---\n", 4));
    expect(front).toContain("# my comment");
    expect(front).toContain("status: open");
    expect(front).toContain("created: 2025-05-07T14:05");
    expect(front).toMatch(/tags:\n {2}- mine\n {2}- review\n {2}- daily/);
    expect(front).toContain("title: Weekly review");
    expect(text.endsWith("Text# Weekly review\nWednesday, May 7th\n\n## Notes\n")).toBe(true);
  });

  it("keeps a value the note already has", () => {
    const { text } = run("---\ntitle: Mine\n---\n", 100, "---\ntitle: Theirs\n---\nbody");
    expect(text).toBe("---\ntitle: Mine\n---\nbody");
  });

  it("moves a cursor inside the frontmatter below it", () => {
    const note = "---\na: 1\n---\nText";
    const { text } = run(note, 6, "---\nb: 2\n---\nbody ");
    expect(text).toBe("---\na: 1\nb: 2\n---\nbody Text");
  });

  it("merges into an empty frontmatter block", () => {
    const { text } = run("---\n---\nText", 0, "---\nb: 2\n---\n");
    expect(text).toBe("---\nb: 2\n---\nText");
  });

  it("inserts a template whose frontmatter is empty as no frontmatter", () => {
    const { text } = run("A", 1, "---\n---\nbody");
    expect(text).toBe("Abody");
  });

  it("inserts the whole text when the template's frontmatter is not valid YAML", () => {
    const template = "---\na: [1\n---\nbody";
    expect(run("", 0, template).text).toBe(template);
  });

  it("refuses a note with invalid frontmatter", () => {
    expect(() => insertTemplate("---\na: [1\n---\nx", 0, "---\nb: 1\n---\n")).toThrow(/not valid YAML/);
  });

  it("reports the cursor after the inserted body", () => {
    const note = "---\na: 1\n---\nText";
    const { text, cursor } = run(note, note.length, "---\nb: 2\n---\nXY");
    expect(text.slice(cursor - 2, cursor)).toBe("XY");
  });
});
