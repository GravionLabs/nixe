// @vitest-environment jsdom
import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";

import { createMarkdownRenderer } from "../markdown-renderer";
import { parseCalloutMarker, resolveCalloutType } from "./callout.plugin";

const md = createMarkdownRenderer({ math: false });
const render = (src: string) => md.render(src);

describe("parseCalloutMarker", () => {
  it("parses type, fold marker, title and rest", () => {
    expect(parseCalloutMarker("[!Tip]- My title\nbody")).toEqual({
      type: "tip",
      fold: "-",
      title: "My title",
      rest: "body",
    });
    expect(parseCalloutMarker("[!note]+")).toEqual({
      type: "note",
      fold: "+",
      title: "",
      rest: "",
    });
    expect(parseCalloutMarker("[!note]")).toMatchObject({ fold: null });
  });
  it("rejects ordinary quotes", () => {
    expect(parseCalloutMarker("just a quote")).toBeNull();
    expect(parseCalloutMarker("[!note]text")).toBeNull();
  });
});

describe("resolveCalloutType", () => {
  it("maps aliases and falls back to note", () => {
    expect(resolveCalloutType("tldr")).toBe("abstract");
    expect(resolveCalloutType("HINT")).toBe("tip");
    expect(resolveCalloutType("error")).toBe("danger");
    expect(resolveCalloutType("cite")).toBe("quote");
    expect(resolveCalloutType("nonsense")).toBe("note");
  });
});

describe("callouts", () => {
  it("renders title row and body", () => {
    const html = render("> [!info] Custom title\n> Body text\n");
    expect(html).toContain('<div class="callout callout-info" data-callout="info"');
    expect(html).toContain('<div class="callout-title">Custom title</div>');
    expect(html).toContain('<div class="callout-content">\n<p>Body text</p>\n</div>');
  });

  it("uses the type name as default title", () => {
    expect(render("> [!warning]\n> careful\n")).toContain(
      '<div class="callout-title">Warning</div>',
    );
  });

  it("renders folded and expanded callouts", () => {
    const folded = render("> [!faq]- Q\n> A\n");
    expect(folded).toContain("is-collapsible is-collapsed");
    expect(folded).toContain('data-callout-fold="-"');
    expect(folded).toContain('aria-expanded="false"');
    const open = render("> [!faq]+ Q\n> A\n");
    expect(open).toContain("is-collapsible");
    expect(open).not.toContain("is-collapsed");
    expect(open).toContain('aria-expanded="true"');
  });

  it("keeps the written alias and maps the class to the canonical type", () => {
    const html = render("> [!tldr]\n> x\n");
    expect(html).toContain('data-callout="tldr"');
    expect(html).toContain("callout-abstract");
    expect(render("> [!unknown]\n> x\n")).toContain("callout-note");
  });

  it("supports nested callouts", () => {
    const html = render("> [!note] Outer\n> text\n>\n> > [!bug] Inner\n> > deep\n");
    expect(html.match(/class="callout /g)).toHaveLength(2);
    expect(html).toContain('data-callout="bug"');
    expect(html.match(/<div/g)?.length).toBe(html.match(/<\/div>/g)?.length);
  });

  it("works for a callout without body and keeps plain blockquotes", () => {
    expect(render("> [!note] Only title\n")).not.toContain("callout-content");
    expect(render("> plain\n")).toContain("<blockquote");
  });

  it("survives DOMPurify unchanged", () => {
    const html = render("> [!tip]- Title\n> body\n");
    const clean = DOMPurify.sanitize(html);
    for (const part of [
      'class="callout callout-tip',
      'data-callout="tip"',
      'data-callout-fold="-"',
      'role="button"',
      'aria-expanded="false"',
      'class="callout-title"',
      'class="callout-content"',
    ]) {
      expect(clean).toContain(part);
    }
  });
});

describe("highlights", () => {
  it("renders ==text== as mark", () => {
    expect(render("a ==b **c**== d")).toContain("a <mark>b <strong>c</strong></mark> d");
  });
  it("ignores unmatched or spaced markers", () => {
    expect(render("a == b == c")).not.toContain("<mark>");
    expect(render("a ==b")).not.toContain("<mark>");
  });
  it("survives DOMPurify", () => {
    expect(DOMPurify.sanitize(render("==x=="))).toContain("<mark>x</mark>");
  });
});

describe("comments", () => {
  it("removes inline comments", () => {
    const html = render("before %%hidden%% after");
    expect(html).toContain("before  after");
    expect(html).not.toContain("hidden");
  });
  it("removes multi-line block comments", () => {
    const html = render("one\n\n%%\nsecret\nmore\n%%\n\ntwo\n");
    expect(html).not.toContain("secret");
    expect(html).toContain(">one<");
    expect(html).toContain(">two<");
  });
  it("removes a single-line block comment and an unterminated one", () => {
    expect(render("%% gone %%\n\nx")).not.toContain("gone");
    expect(render("x\n\n%%\nnever closed\nstill\n")).not.toContain("closed");
  });
  it("leaves code alone", () => {
    expect(render("`%%keep%%`")).toContain("%%keep%%");
    expect(render("```\n%%keep%%\n```\n")).toContain("%%keep%%");
  });
});
