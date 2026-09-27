import type { Mermaid } from "mermaid";

let mermaidLoader: Promise<Mermaid> | null = null;

/** Mermaid is large, so it is only loaded once a document contains a diagram. */
function loadMermaid(): Promise<Mermaid> {
  return (mermaidLoader ??= import("mermaid").then((m) => m.default));
}

const MAX_CACHE = 200;

/**
 * Replaces `<pre class="mermaid">` placeholders with rendered SVGs.
 * SVGs are cached by source, so re-rendering while typing only renders the
 * diagram that actually changed and the preview doesn't flicker.
 */
export class MermaidRenderer {
  private readonly cache = new Map<string, string>();
  private theme = "";
  private seq = 0;

  async render(root: HTMLElement, dark: boolean): Promise<void> {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("pre.mermaid"));
    if (!nodes.length) return;

    const mermaid = await loadMermaid();
    const theme = dark ? "dark" : "default";
    if (theme !== this.theme) {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
      this.theme = theme;
      this.cache.clear();
    }
    if (this.cache.size > MAX_CACHE) this.cache.clear();

    for (const node of nodes) {
      // A newer render may already have replaced the content.
      if (!node.isConnected) continue;
      const source = node.textContent ?? "";

      let svg = this.cache.get(source);
      if (svg === undefined) {
        const id = `nixe-mermaid-${++this.seq}`;
        try {
          svg = (await mermaid.render(id, source)).svg;
          this.cache.set(source, svg);
        } catch (err) {
          // mermaid leaves its temporary render container behind on errors
          document.getElementById(id)?.remove();
          document.getElementById(`d${id}`)?.remove();
          if (node.isConnected) node.replaceWith(errorBox(node, source, err));
          continue;
        }
      }
      if (!node.isConnected) continue;

      const figure = document.createElement("div");
      figure.className = "mermaid-diagram";
      if (node.dataset["line"]) figure.dataset["line"] = node.dataset["line"];
      figure.innerHTML = svg;
      node.replaceWith(figure);
    }
  }
}

function errorBox(node: HTMLElement, source: string, err: unknown): HTMLElement {
  const box = document.createElement("div");
  box.className = "mermaid-error";
  if (node.dataset["line"]) box.dataset["line"] = node.dataset["line"];

  const title = document.createElement("strong");
  title.textContent = "Mermaid error";
  const message = document.createElement("pre");
  message.textContent = err instanceof Error ? err.message : String(err);
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Source";
  const code = document.createElement("pre");
  code.textContent = source;
  details.append(summary, code);

  box.append(title, message, details);
  return box;
}
