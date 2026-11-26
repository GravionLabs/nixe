// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { createMarkdownRenderer } from "../markdown/markdown-renderer";
import {
  buildHtmlDocument,
  collectContentCss,
  inlineFonts,
  inlineImages,
  isContentRule,
  noteTitle,
  plainWikilinks,
  printCss,
  sanitizePageSize,
  stripAppControls,
  type ExportOptions,
} from "./export-core";

const light: ExportOptions = { dark: false, pageSize: "A4", pageBreaks: true };

function el(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

describe("page size", () => {
  it("accepts the known sizes in any case and falls back to A4", () => {
    expect(sanitizePageSize("letter")).toBe("Letter");
    expect(sanitizePageSize(" a3 ")).toBe("A3");
    expect(sanitizePageSize("B7")).toBe("A4");
    expect(sanitizePageSize(4)).toBe("A4");
  });
});

describe("note content", () => {
  it("turns wikilinks into plain text and keeps other links", () => {
    const root = el(
      '<p><a class="wikilink" data-target="B" href="#">alias</a> <a class="wikilink unresolved" href="#">gone</a> <a href="https://x.dev">web</a></p>',
    );
    plainWikilinks(root);
    expect(root.querySelector("a.wikilink")).toBeNull();
    expect(root.textContent).toBe("alias gone web");
    expect(root.querySelectorAll("a")).toHaveLength(1);
  });

  it("removes the copy buttons and the viewer's line markers", () => {
    const root = el(
      '<div class="code-block"><div class="code-tools" contenteditable="false"><button class="code-copy">Copy</button></div><pre data-line="3"><code>x</code></pre></div><img data-zoomable role="button" tabindex="0" src="a.png">',
    );
    stripAppControls(root);
    expect(root.querySelector("button, .code-tools")).toBeNull();
    expect(root.querySelector("pre")?.hasAttribute("data-line")).toBe(false);
    const img = root.querySelector("img")!;
    expect(img.hasAttribute("role") || img.hasAttribute("tabindex")).toBe(false);
  });

  it("keeps the placeholder of a base without its source", () => {
    const root = el(
      '<div class="base-block" data-base="views%3A%20%5B%5D" data-line="2"><p class="base-placeholder">Base</p></div>',
    );
    stripAppControls(root);
    expect(root.innerHTML).toBe(
      '<div class="base-block"><p class="base-placeholder">Base</p></div>',
    );
    expect(isContentRule(".markdown-body .base-placeholder { opacity: 0.7; }")).toBe(true);
  });

  it("inlines local images once per file and leaves remote ones", async () => {
    const root = el(
      '<img src="asset://localhost/%2Fv%2Fa.png"><img src="asset://localhost/%2Fv%2Fa.png"><img src="https://x.dev/b.png"><img src="asset://localhost/%2Fv%2Fgone.png">',
    );
    const read: string[] = [];
    await inlineImages(root, async (path) => {
      read.push(path);
      return path.endsWith("a.png") ? "data:image/png;base64,AA==" : null;
    });
    const srcs = Array.from(root.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([
      "data:image/png;base64,AA==",
      "data:image/png;base64,AA==",
      "https://x.dev/b.png",
      "asset://localhost/%2Fv%2Fgone.png",
    ]);
    expect(read).toEqual(["/v/a.png", "/v/gone.png"]);
  });

  it("names the note after its file", () => {
    expect(noteTitle("/v/sub/Plan.md")).toBe("Plan");
    expect(noteTitle("C:\\v\\Plan.MD")).toBe("Plan");
  });
});

describe("stylesheet", () => {
  it("keeps the rules of note content and drops the app's own", () => {
    expect(isContentRule(":root:not(.app-dark) .markdown-body h1 { color: red; }")).toBe(true);
    expect(isContentRule(".katex .base { display: inline-block; }")).toBe(true);
    expect(isContentRule(".hljs-keyword { color: red; }")).toBe(true);
    expect(isContentRule(":root { --h-text-color: #111; }")).toBe(true);
    expect(isContentRule("@font-face { font-family: KaTeX_Main; src: url(a.woff2); }")).toBe(true);
    expect(isContentRule("@font-face { font-family: Inter; src: url(a.woff2); }")).toBe(false);
    expect(isContentRule(".sidebar { width: 10px; }")).toBe(false);
    expect(isContentRule("button.toolbar { color: red; }")).toBe(false);
  });

  it("collects across sheets and skips one it cannot read", () => {
    const unreadable = {
      get cssRules(): never {
        throw new Error("SecurityError");
      },
    };
    const css = collectContentCss([
      { cssRules: [{ cssText: ".markdown-body p {}" }, { cssText: ".sidebar {}" }] },
      unreadable,
      { cssRules: [{ cssText: ".katex {}" }] },
    ]);
    expect(css).toBe(".markdown-body p {}\n.katex {}");
  });

  it("inlines the woff2 of a font and drops the other formats", async () => {
    const css =
      '@font-face { font-family: KaTeX_Main; src: url("fonts/a.woff2") format("woff2"), url("fonts/a.woff") format("woff"), url("fonts/a.ttf") format("truetype"); font-weight: 400; }';
    const out = await inlineFonts(css, async (url) =>
      url === "fonts/a.woff2" ? "data:font/woff2;base64,AA==" : null,
    );
    expect(out).toContain('src: url(data:font/woff2;base64,AA==) format("woff2")');
    expect(out).not.toContain('.woff"');
    expect(out).toContain("font-weight: 400");
  });

  it("keeps a font as it is when the bundle has no file", async () => {
    const css = '@font-face { src: url(a.woff2) format("woff2"), url(a.ttf); }';
    expect(await inlineFonts(css, async () => null)).toBe(css);
  });
});

describe("print stylesheet", () => {
  it("sets the page size and breaks before top-level headings except the first", () => {
    const css = printCss({ ...light, pageSize: "Letter" });
    expect(css).toContain("size: Letter");
    expect(css).toMatch(/h1:not\(:first-child\) \{ break-before: page; \}/u);
  });

  it("does not clip the labels of a diagram", () => {
    expect(printCss(light)).toContain(".mermaid-diagram foreignObject { overflow: visible; }");
  });

  it("has no page breaks when the setting is off", () => {
    expect(printCss({ ...light, pageBreaks: false })).not.toContain("break-before");
  });
});

describe("html document", () => {
  const doc = (options: ExportOptions) =>
    buildHtmlDocument({
      title: 'A <b> & "c"',
      body: "<h1>Hi</h1>",
      css: ".markdown-body{}",
      options,
    });

  it("is one file: no script, no external stylesheet or file", () => {
    const html = doc(light);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>A &lt;b&gt; &amp; &quot;c&quot;</title>");
    expect(html).toContain('<article class="markdown-body">\n<h1>Hi</h1>');
    expect(html).not.toMatch(/<script|<link/u);
  });

  it("is light or dark by option", () => {
    expect(doc(light)).toContain('class=""');
    expect(doc(light)).toContain("color-scheme: light");
    const dark = doc({ ...light, dark: true });
    expect(dark).toContain('class="app-dark"');
    expect(dark).toContain("color-scheme: dark");
  });
});

describe("a rendered note", () => {
  const md = createMarkdownRenderer({ math: true });
  const body = (text: string) => md.render(text, { vaultFiles: ["Other.md"] });

  it("never carries a %%comment%%, inline or as a block", () => {
    const html = buildHtmlDocument({
      title: "n",
      body: body("Visible %%secret one%% text\n\n%%\nsecret two\n%%\n\nEnd"),
      css: "",
      options: light,
    });
    expect(html).toContain("Visible");
    expect(html).toContain("End");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("%%");
  });

  it("renders math with KaTeX and a diagram as a placeholder for the renderer", () => {
    const html = body("$x^2$\n\n```mermaid\ngraph TD; A-->B\n```\n");
    expect(html).toContain('class="katex"');
    expect(html).toContain('<pre class="mermaid"');
  });
});
