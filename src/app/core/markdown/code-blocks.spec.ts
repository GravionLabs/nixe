// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMarkdownRenderer } from "./markdown-renderer";
import { COPIED_MS, decorateCodeBlocks, handleCopyClick, sourceOf } from "./code-blocks";

const md = createMarkdownRenderer({ math: true });

function mount(src: string): HTMLElement {
  const root = document.createElement("article");
  root.innerHTML = md.render(src);
  decorateCodeBlocks(root);
  return root;
}

describe("decorateCodeBlocks", () => {
  it("adds a button and the language label to a fenced block", () => {
    const root = mount("```ts\nconst a = 1;\n```\n");
    expect(root.querySelector(".code-block > pre")).not.toBeNull();
    expect(root.querySelector(".code-copy")?.textContent).toBe("Copy");
    expect(root.querySelector(".code-lang")?.textContent).toBe("ts");
  });

  it("shows no label without a language", () => {
    const root = mount("```\nplain\n```\n");
    expect(root.querySelector(".code-copy")).not.toBeNull();
    expect(root.querySelector(".code-lang")).toBeNull();
  });

  it("is idempotent", () => {
    const root = mount("```ts\nx\n```\n");
    decorateCodeBlocks(root);
    expect(root.querySelectorAll(".code-copy")).toHaveLength(1);
  });

  it("keeps the tools out of selections", () => {
    const root = mount("```ts\nx\n```\n");
    expect(root.querySelector(".code-tools")?.getAttribute("contenteditable")).toBe("false");
  });

  it("decorates math blocks and rendered diagrams, not the diagram placeholder", () => {
    const root = mount("$$\n\\int_0^1 x\\,dx\n$$\n\n```mermaid\ngraph TD; A-->B\n```\n");
    expect(root.querySelector(".katex-display .code-copy")).not.toBeNull();
    expect(root.querySelector("pre.mermaid")?.closest(".code-block")).toBeNull();
    const figure = document.createElement("div");
    figure.className = "mermaid-diagram";
    figure.dataset["source"] = "graph TD; A-->B";
    figure.innerHTML = "<svg></svg>";
    root.append(figure);
    decorateCodeBlocks(root);
    expect(figure.querySelector(".code-copy")).not.toBeNull();
    expect(sourceOf(figure)).toBe("graph TD; A-->B");
  });
});

describe("sourceOf", () => {
  it("is the code without the fence or the highlighting", () => {
    const root = mount("```ts\nconst a = 1;\n```\n");
    expect(sourceOf(root.querySelector<HTMLElement>(".code-block")!)).toBe("const a = 1;\n");
  });

  it("is the TeX of a math block", () => {
    const root = mount("$$\n\\int_0^1 x\\,dx\n$$\n");
    expect(sourceOf(root.querySelector<HTMLElement>(".katex-display")!)).toContain("\\int_0^1 x\\,dx");
  });
});

describe("handleCopyClick", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("copies the source and shows Copied for 2 s", async () => {
    const root = mount("```ts\nconst a = 1;\n```\n");
    const button = root.querySelector<HTMLElement>(".code-copy")!;
    const write = vi.fn().mockResolvedValue(undefined);
    expect(await handleCopyClick(button, write)).toBe(true);
    expect(write).toHaveBeenCalledWith("const a = 1;\n");
    expect(button.textContent).toBe("Copied");
    vi.advanceTimersByTime(COPIED_MS - 1);
    expect(button.textContent).toBe("Copied");
    vi.advanceTimersByTime(1);
    expect(button.textContent).toBe("Copy");
  });

  it("ignores other clicks", async () => {
    const root = mount("```ts\nx\n```\n");
    expect(await handleCopyClick(root.querySelector("pre")!, vi.fn())).toBe(false);
  });
});

describe("sanitizing", () => {
  it("keeps the TeX source of a math block", async () => {
    const { default: DOMPurify } = await import("dompurify");
    const { SANITIZE } = await import("./markdown.service");
    const root = document.createElement("article");
    root.innerHTML = DOMPurify.sanitize(md.render("$$\nx^2\n$$\n"), SANITIZE);
    decorateCodeBlocks(root);
    expect(sourceOf(root.querySelector<HTMLElement>(".katex-display")!)).toContain("x^2");
  });
});
