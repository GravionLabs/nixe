// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { MarkdownService } from "../markdown.service";
import { createMarkdownRenderer } from "../markdown-renderer";
import { BASE_PLACEHOLDER } from "./base-fence.plugin";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html").body;

describe("base fence", () => {
  const source = 'filters: file.name != "-->" # </style> <script>alert(1)</script>\n';
  const note = `\`\`\`Base\n${source}\`\`\`\n`;

  it("is a placeholder block that carries its source through the sanitizer", () => {
    const service = new MarkdownService();
    const body = parse(
      service.render(note, { filePath: null, wikiRoot: null, math: true, bases: true }),
    );

    const block = body.querySelector<HTMLElement>("div.base-block")!;
    expect(decodeURIComponent(block.dataset["base"]!)).toBe(source);
    expect(block.textContent).toBe(BASE_PLACEHOLDER);
    expect(block.dataset["line"]).toBe("0");
    expect(body.querySelector("script, pre")).toBeNull();
  });

  it("stays a code block where bases are not asked for", () => {
    const body = parse(createMarkdownRenderer({ math: false }).render(note));

    expect(body.querySelector("pre > code")!.textContent).toBe(source);
    expect(body.querySelector(".base-block")).toBeNull();
  });

  it("leaves other fences as code and survives a lone surrogate", () => {
    const md = createMarkdownRenderer({ math: false, bases: true });

    expect(parse(md.render("```yaml\na: 1\n```\n")).querySelector("pre > code")).not.toBeNull();
    const block = parse(md.render("```base\n\uD800\n```\n")).querySelector<HTMLElement>("div")!;
    expect(decodeURIComponent(block.dataset["base"]!)).toBe("�\n");
  });
});
