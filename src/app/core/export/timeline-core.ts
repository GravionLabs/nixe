import { pageContentWidth, type PageSize } from "./export-core";

/** The label size of a Mermaid timeline, in px of its `viewBox`. */
const LABEL_PX = 16;
/** Labels printed smaller than this are not readable: the timeline is drawn vertically. */
const MIN_LABEL_PX = 9;
/** Mermaid repeats its section colours after this many (`THEME_COLOR_LIMIT`). */
const SECTION_COLORS = 12;

export type TimelineLayout = "vertical" | "horizontal";

export interface TimelinePeriod {
  period: string;
  events: string[];
}

export interface TimelineSection {
  /** `null` for the periods that stand before the first `section`. */
  name: string | null;
  periods: TimelinePeriod[];
}

export interface Timeline {
  title: string | null;
  sections: TimelineSection[];
}

/** Background and label colour of a section. */
export interface SectionColor {
  background: string;
  text: string;
}

const FRONTMATTER = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/u;
const DIRECTIVE = /%%\{[\s\S]*?\}%%/gu;
/** The keyword of the diagram; a statement may follow it on the same line. */
const HEADER = /^timeline(?:[ \t]+(?:LR|TD))?(?=\s|$)/iu;
const OVERRIDE = /^[ \t]*%%[ \t]*nixe[ \t]*:[ \t]*(vertical|horizontal)[ \t]*$/imu;
/** Mermaid writes characters as `#35;` or `#quot;`; their `#` starts no comment. */
const ENTITY = /#(\w+);/gu;
const ENTITY_MARK = "\u0001";

/** The layout a `%% nixe: vertical|horizontal` comment of the diagram asks for. */
export function layoutOverride(source: string): TimelineLayout | null {
  const wanted = OVERRIDE.exec(source)?.[1];
  return wanted ? (wanted.toLowerCase() as TimelineLayout) : null;
}

function decodeEntity(name: string): string {
  const probe = document.createElement("textarea");
  probe.innerHTML = /^\d+$/u.test(name) ? `&#${name};` : `&${name};`;
  return probe.value;
}

/** A label as it is shown: entities decoded, `<br>` as a line break. */
function label(raw: string): string {
  return raw
    .trim()
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(new RegExp(`${ENTITY_MARK}(\\w+);`, "gu"), (_, name: string) => decodeEntity(name));
}

/** The content of a Mermaid `timeline`; `null` for every other diagram. */
export function parseTimeline(source: string): Timeline | null {
  const front = FRONTMATTER.exec(source);
  const frontTitle = /^title:[ \t]*(["']?)(.*?)\1[ \t]*$/mu.exec(front?.[1] ?? "")?.[2];
  const lines = source
    .slice(front?.[0].length ?? 0)
    .replace(DIRECTIVE, "")
    .replace(ENTITY, `${ENTITY_MARK}$1;`)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("%") && !line.startsWith("#"));
  const first = lines.shift() ?? "";
  const header = HEADER.exec(first)?.[0];
  if (!header) return null;
  const rest = first.slice(header.length).trim();
  if (rest) lines.unshift(rest);

  const timeline: Timeline = { title: frontTitle ? label(frontTitle) : null, sections: [] };
  let section: TimelineSection | undefined;
  let period: TimelinePeriod | undefined;
  let inDescription = false;
  for (const line of lines) {
    if (inDescription || /^accDescr\s*\{/iu.test(line)) {
      inDescription = !line.includes("}");
      continue;
    }
    if (/^acc(?:Title|Descr)\s*:/iu.test(line)) continue;
    const title = /^title\s+(.+)$/iu.exec(line)?.[1];
    if (title) {
      timeline.title = label(title);
      continue;
    }
    const name = /^section\s+([^:]+)/iu.exec(line)?.[1];
    if (name) {
      section = { name: label(name), periods: [] };
      timeline.sections.push(section);
      continue;
    }
    // A colon separates only when a space follows (`10:30` is text).
    const [head, ...events] = line.split(/:(?=\s|$)/u);
    const comment = head.indexOf("#");
    const start = (comment < 0 ? head : head.slice(0, comment)).trim();
    if (start) {
      if (!section) {
        section = { name: null, periods: [] };
        timeline.sections.push(section);
      }
      period = { period: label(start), events: [] };
      section.periods.push(period);
    }
    // A comment in the period takes the rest of the line with it.
    if (comment < 0) period?.events.push(...events.map(label).filter(Boolean));
  }
  return timeline;
}

/** The width of the `viewBox` of an SVG; `null` without a usable one. */
export function viewBoxWidth(svg: Element | null): number | null {
  const width = Number(
    svg
      ?.getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/u)[2],
  );
  return Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * Horizontal while the labels stay readable once the SVG is scaled to the page width;
 * the override of the diagram wins.
 */
export function timelineLayout(
  source: string,
  width: number | null,
  pageSize: PageSize,
): TimelineLayout {
  const forced = layoutOverride(source);
  if (forced) return forced;
  if (width === null) return "horizontal";
  const scale = pageContentWidth(pageSize) / width;
  return scale * LABEL_PX < MIN_LABEL_PX ? "vertical" : "horizontal";
}

function block(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * The vertical layout: one row per period, sections as headings. A heading is kept on the page
 * of its first row; `colors[i]` belongs to the `i`-th named section.
 */
export function verticalTimeline(
  timeline: Timeline,
  colors: readonly (SectionColor | null)[] = [],
): HTMLElement {
  const root = block("div", "timeline-vertical");
  // Headings that wait for the row they must not be separated from.
  let headings: HTMLElement[] = [];
  if (timeline.title) headings.push(block("div", "timeline-title", timeline.title));
  let named = 0;
  for (const section of timeline.sections) {
    if (section.name !== null) {
      const heading = block("div", "timeline-section-title", section.name);
      const color = colors[named++];
      if (color) {
        heading.style.backgroundColor = color.background;
        heading.style.color = color.text;
      }
      headings.push(heading);
    }
    for (const { period, events } of section.periods) {
      const row = block("div", "timeline-row");
      const list = block("ul", "timeline-events");
      list.append(...events.map((event) => block("li", "", event)));
      row.append(block("div", "timeline-period", period), list);
      if (headings.length) {
        const keep = block("div", "timeline-keep");
        keep.append(...headings, row);
        headings = [];
        root.append(keep);
      } else {
        root.append(row);
      }
    }
  }
  root.append(...headings);
  return root;
}

/** The colours Mermaid gave the first `count` sections of a rendered timeline. */
export function sectionColors(diagram: Element, count: number): (SectionColor | null)[] {
  return Array.from({ length: count }, (_, i) => {
    // The first node of a colour class is the section's own box.
    const node = diagram.querySelector(`.timeline-node.section-${(i % SECTION_COLORS) - 1}`);
    const shape = node?.querySelector("path, rect");
    const text = node?.querySelector("text");
    if (!shape || !text) return null;
    return { background: getComputedStyle(shape).fill, text: getComputedStyle(text).fill };
  });
}

/**
 * Replaces every rendered timeline of `root` that does not fit the page by its vertical layout.
 * `root` must be in the document, so the section colours can be read.
 */
export function fitTimelines(root: ParentNode, pageSize: PageSize): void {
  for (const diagram of Array.from(root.querySelectorAll<HTMLElement>(".mermaid-diagram"))) {
    const source = diagram.dataset["source"] ?? "";
    const timeline = parseTimeline(source);
    if (!timeline?.sections.length) continue;
    const width = viewBoxWidth(diagram.querySelector("svg"));
    if (timelineLayout(source, width, pageSize) !== "vertical") continue;
    const named = timeline.sections.filter((s) => s.name !== null).length;
    diagram.replaceWith(verticalTimeline(timeline, sectionColors(diagram, named)));
  }
}
