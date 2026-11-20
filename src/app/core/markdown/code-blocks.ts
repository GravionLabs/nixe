/** How long the copy button reads "Copied". */
export const COPIED_MS = 2000;

export const CODE_BLOCK_CLASS = "code-block";
export const COPY_BUTTON_CLASS = "code-copy";

/**
 * The source of a block: the text of a code block without the fence, the `source` of a diagram
 * (set by the Mermaid renderer), or the TeX of a KaTeX block.
 */
export function sourceOf(block: HTMLElement): string {
  const stored = block.dataset["source"];
  if (stored !== undefined) return stored;
  const tex = block.querySelector('annotation[encoding="application/x-tex"]');
  if (tex) return tex.textContent ?? "";
  const code = block.querySelector("pre > code") ?? block.querySelector("pre") ?? block;
  return code.textContent ?? "";
}

function language(pre: HTMLElement): string {
  const cls = Array.from(pre.querySelector("code")?.classList ?? []).find((c) =>
    c.startsWith("language-"),
  );
  return cls ? cls.slice("language-".length) : "";
}

function makeButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = COPY_BUTTON_CLASS;
  button.textContent = "Copy";
  button.title = "Copy the source";
  button.setAttribute("aria-label", "Copy the source");
  return button;
}

function makeBar(label: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "code-tools";
  // Neither the label nor the button is part of a selection or its copy.
  bar.setAttribute("contenteditable", "false");
  if (label) {
    const span = document.createElement("span");
    span.className = "code-lang";
    span.textContent = label;
    bar.append(span);
  }
  bar.append(makeButton());
  return bar;
}

/**
 * Puts a copy button (and the language label of a fenced block) on every code block, KaTeX
 * block and rendered diagram of `root`. Safe to call again; decorated blocks are skipped.
 */
export function decorateCodeBlocks(root: HTMLElement): void {
  for (const pre of Array.from(root.querySelectorAll<HTMLElement>("pre"))) {
    if (pre.classList.contains("mermaid") || pre.closest(`.${CODE_BLOCK_CLASS}, .mermaid-error`))
      continue;
    const wrap = document.createElement("div");
    wrap.className = CODE_BLOCK_CLASS;
    // Scroll sync looks for the top-level blocks with a source line.
    // markdown-it puts it on the `<code>` of a fence.
    const line =
      pre.dataset["line"] ?? pre.querySelector<HTMLElement>(":scope > code")?.dataset["line"];
    if (line !== undefined) wrap.dataset["line"] = line;
    pre.replaceWith(wrap);
    wrap.append(pre, makeBar(language(pre)));
  }
  for (const block of Array.from(
    root.querySelectorAll<HTMLElement>(".katex-display, .mermaid-diagram"),
  )) {
    if (block.querySelector(`:scope > .code-tools`) || block.closest(`.${CODE_BLOCK_CLASS}`))
      continue;
    block.classList.add(CODE_BLOCK_CLASS, "code-block-source");
    block.append(makeBar(""));
  }
}

/** Copies the source of the block whose copy button was clicked; false when `target` is no such button. */
export async function handleCopyClick(
  target: Element,
  write: (text: string) => Promise<void> = (t) => navigator.clipboard.writeText(t),
): Promise<boolean> {
  const button = target.closest<HTMLButtonElement>(`.${COPY_BUTTON_CLASS}`);
  const block = button?.closest<HTMLElement>(`.${CODE_BLOCK_CLASS}`);
  if (!button || !block) return false;
  try {
    await write(sourceOf(block));
    button.textContent = "Copied";
  } catch {
    button.textContent = "Failed";
  }
  clearTimeout(Number(button.dataset["timer"]));
  button.dataset["timer"] = String(
    setTimeout(() => {
      button.textContent = "Copy";
      delete button.dataset["timer"];
    }, COPIED_MS),
  );
  return true;
}
