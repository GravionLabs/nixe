// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createMarkdownRenderer } from "../markdown/markdown-renderer";
import { pageContentWidth, printCss } from "./export-core";
import {
  fitTimelines,
  layoutOverride,
  parseTimeline,
  timelineLayout,
  verticalTimeline,
  viewBoxWidth,
} from "./timeline-core";

const SOURCE = `timeline
    title History
    section Early
      2002 : LinkedIn
      2004 : Facebook : Google
           : Flickr
    section Late
      2005 : YouTube
`;

describe("fit decision", () => {
  it("knows the content width of the page: size minus the margins", () => {
    expect(pageContentWidth("A4")).toBeCloseTo(657.6, 0);
    expect(pageContentWidth("A3")).toBeCloseTo(986.5, 0);
    expect(pageContentWidth("Letter")).toBeCloseTo(679.9, 0);
    expect(printCss({ dark: false, pageSize: "A4", pageBreaks: false })).toContain("margin: 18mm");
  });

  it("turns vertical when the labels would be printed below 9 px", () => {
    const limit = (pageContentWidth("A4") * 16) / 9;
    expect(timelineLayout(SOURCE, limit - 1, "A4")).toBe("horizontal");
    expect(timelineLayout(SOURCE, limit + 1, "A4")).toBe("vertical");
    expect(timelineLayout(SOURCE, 3390, "A4")).toBe("vertical");
    expect(timelineLayout(SOURCE, 3390, "A3")).toBe("vertical");
  });

  it("depends on the page size", () => {
    expect(timelineLayout(SOURCE, 1500, "A4")).toBe("vertical");
    expect(timelineLayout(SOURCE, 1500, "A3")).toBe("horizontal");
  });

  it("stays horizontal without a viewBox", () => {
    expect(timelineLayout(SOURCE, null, "A4")).toBe("horizontal");
  });

  it("obeys the comment of the diagram", () => {
    expect(timelineLayout(`${SOURCE}%% nixe: vertical\n`, 100, "A4")).toBe("vertical");
    expect(timelineLayout(`  %%nixe:Horizontal\n${SOURCE}`, 9999, "A4")).toBe("horizontal");
    expect(layoutOverride("timeline\n 2002 : %% nixe: vertical")).toBeNull();
  });

  it("reads the width of a viewBox", () => {
    const el = document.createElement("div");
    el.innerHTML = '<svg viewBox="-100 -61 3390 500"></svg>';
    expect(viewBoxWidth(el.firstElementChild)).toBe(3390);
    expect(viewBoxWidth(el)).toBeNull();
    expect(viewBoxWidth(null)).toBeNull();
  });
});

describe("parseTimeline", () => {
  it("reads title, sections, periods and events", () => {
    expect(parseTimeline(SOURCE)).toEqual({
      title: "History",
      sections: [
        {
          name: "Early",
          periods: [
            { period: "2002", events: ["LinkedIn"] },
            { period: "2004", events: ["Facebook", "Google", "Flickr"] },
          ],
        },
        { name: "Late", periods: [{ period: "2005", events: ["YouTube"] }] },
      ],
    });
  });

  it("handles directives, frontmatter, comments, entities and colons in text", () => {
    const parsed = parseTimeline(`---
title: "From the top"
---
%%{init: {"theme": "forest"}}%%
%% a comment
timeline TD
    accTitle: hidden
    accDescr {
      hidden too
    }
    # another comment
    Day 1 : at 10:30 : C#59; and #quot;x#quot;<br/>next
    Day 2
`);
    expect(parsed).toEqual({
      title: "From the top",
      sections: [
        {
          name: null,
          periods: [
            { period: "Day 1", events: ["at 10:30", 'C; and "x"\nnext'] },
            { period: "Day 2", events: [] },
          ],
        },
      ],
    });
  });

  it("follows Mermaid on one-line headers and comments after a period", () => {
    expect(parseTimeline("timeline title History\n  2002 #1 : LinkedIn")).toEqual({
      title: "History",
      sections: [{ name: null, periods: [{ period: "2002", events: [] }] }],
    });
  });

  it("ignores other diagrams", () => {
    expect(parseTimeline("flowchart LR\n A --> B")).toBeNull();
    expect(parseTimeline("gantt\n title timeline")).toBeNull();
  });
});

describe("vertical markup", () => {
  it("has the title, the coloured sections, one row per period and a list of events", () => {
    const root = verticalTimeline(parseTimeline(SOURCE)!, [
      { background: "rgb(1, 2, 3)", text: "rgb(4, 5, 6)" },
    ]);
    expect(root.className).toBe("timeline-vertical");
    expect(root.querySelector(".timeline-title")?.textContent).toBe("History");
    const headings = root.querySelectorAll<HTMLElement>(".timeline-section-title");
    expect(Array.from(headings, (h) => h.textContent)).toEqual(["Early", "Late"]);
    expect(headings[0].style.backgroundColor).toBe("rgb(1, 2, 3)");
    expect(headings[0].style.color).toBe("rgb(4, 5, 6)");
    expect(headings[1].getAttribute("style")).toBeNull();
    expect(root.querySelectorAll(".timeline-row")).toHaveLength(3);
    expect(root.querySelectorAll(".timeline-row")[1].querySelectorAll("li")).toHaveLength(3);
  });

  it("keeps each heading with its first row", () => {
    const keeps = verticalTimeline(parseTimeline(SOURCE)!).querySelectorAll(".timeline-keep");
    expect(keeps).toHaveLength(2);
    expect(keeps[0].children).toHaveLength(3);
    expect(keeps[1].children).toHaveLength(2);
  });

  it("writes text only, never markup", () => {
    const root = verticalTimeline(
      parseTimeline("timeline\n <img src=x onerror=a()> : <script>b()</script> : #lt;i#gt;")!,
    );
    expect(root.querySelector("img, script, i")).toBeNull();
    expect(root.textContent).toContain("<script>b()</script>");
    expect(root.textContent).toContain("<i>");
  });
});

describe("fitTimelines", () => {
  const rendered = (source: string, width: number) => {
    const root = document.createElement("div");
    const figure = document.createElement("div");
    figure.className = "mermaid-diagram";
    figure.dataset["source"] = source;
    figure.innerHTML = `<svg viewBox="0 0 ${width} 100"><g class="timeline-node section--1"><path style="fill: rgb(1, 2, 3)"></path><text style="fill: rgb(4, 5, 6)">Early</text></g></svg>`;
    root.append(figure);
    document.body.replaceChildren(root);
    return root;
  };

  it("replaces a timeline that is too wide and takes over the section colours", () => {
    const root = rendered(SOURCE, 3390);
    fitTimelines(root, "A4");
    expect(root.querySelector("svg, .mermaid-diagram")).toBeNull();
    expect(root.querySelector<HTMLElement>(".timeline-section-title")?.style.backgroundColor).toBe(
      "rgb(1, 2, 3)",
    );
  });

  it("keeps a timeline that fits, and every other diagram", () => {
    const fits = rendered(SOURCE, 800);
    fitTimelines(fits, "A4");
    expect(fits.querySelector("svg")).not.toBeNull();
    const flow = rendered("flowchart LR\n%% nixe: vertical\n A-->B", 9999);
    fitTimelines(flow, "A4");
    expect(flow.querySelector("svg")).not.toBeNull();
  });

  it("gets the override from the Markdown block, in both fence syntaxes", () => {
    const md = createMarkdownRenderer({ math: false });
    for (const [open, close] of [
      ["```mermaid", "```"],
      [":::mermaid", ":::"],
    ]) {
      const root = document.createElement("div");
      root.innerHTML = md.render(`${open}\ntimeline\n%% nixe: vertical\n 2002 : A\n${close}\n`);
      expect(layoutOverride(root.querySelector("pre.mermaid")!.textContent!)).toBe("vertical");
    }
  });
});
