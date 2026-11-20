import type { MarkdownIt, Token } from "markdown-it";

/** Obsidian callout types and their aliases → canonical type (which carries icon and color). */
const CALLOUT_ALIASES: Record<string, string> = {
  note: "note",
  abstract: "abstract",
  summary: "abstract",
  tldr: "abstract",
  info: "info",
  todo: "todo",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "success",
  check: "success",
  done: "success",
  question: "question",
  help: "question",
  faq: "question",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  failure: "failure",
  fail: "failure",
  missing: "failure",
  danger: "danger",
  error: "danger",
  bug: "bug",
  example: "example",
  quote: "quote",
  cite: "quote",
};

/** Canonical callout types; unknown types fall back to `note`. */
export function resolveCalloutType(type: string): string {
  return CALLOUT_ALIASES[type.toLowerCase()] ?? "note";
}

export interface CalloutMarker {
  /** As written, lowercased. */
  type: string;
  fold: "-" | "+" | null;
  title: string;
  /** Text after the first line (the first lines of the callout body). */
  rest: string;
}

const MARKER_RE = /^\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/;

/** Parses the first paragraph of a blockquote (`[!type]+ Title\nbody`), or returns null. */
export function parseCalloutMarker(content: string): CalloutMarker | null {
  const m = MARKER_RE.exec(content);
  if (!m) return null;
  const type = m[1].toLowerCase();
  return {
    type,
    fold: (m[2] as "-" | "+" | undefined) ?? null,
    title: (m[3] ?? "").trim(),
    rest: m[4] ?? "",
  };
}

/**
 * Obsidian callouts: a blockquote whose first line is `[!type]`, `[!type]-` (folded) or
 * `[!type]+` (expanded) with an optional title. Rendered as
 * `div.callout > div.callout-title + div.callout-content`; folding is toggled by the viewer.
 */
export function calloutPlugin(md: MarkdownIt): void {
  md.core.ruler.after("block", "callout", (state) => {
    const tokens = state.tokens;
    // Back to front: nested callouts are inner (later) tokens, and edits don't shift earlier indices.
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].type !== "blockquote_open") continue;
      const open = tokens[i];
      const para = tokens[i + 1];
      const inline = tokens[i + 2];
      const paraClose = tokens[i + 3];
      if (
        para?.type !== "paragraph_open" ||
        inline?.type !== "inline" ||
        paraClose?.type !== "paragraph_close"
      ) {
        continue;
      }
      const marker = parseCalloutMarker(inline.content);
      if (!marker) continue;

      let close = i + 4;
      while (
        close < tokens.length &&
        !(tokens[close].type === "blockquote_close" && tokens[close].level === open.level)
      ) {
        close++;
      }
      if (close >= tokens.length) continue;

      const kind = resolveCalloutType(marker.type);
      open.tag = "div";
      open.attrSet(
        "class",
        `callout callout-${kind}${marker.fold ? ` is-collapsible${marker.fold === "-" ? " is-collapsed" : ""}` : ""}`,
      );
      open.attrSet("data-callout", marker.type);
      if (marker.fold) open.attrSet("data-callout-fold", marker.fold);
      tokens[close].tag = "div";

      para.tag = "div";
      para.attrSet("class", "callout-title");
      if (marker.fold) {
        para.attrSet("role", "button");
        para.attrSet("aria-expanded", marker.fold === "+" ? "true" : "false");
      }
      paraClose.tag = "div";
      inline.content = marker.title || marker.type.charAt(0).toUpperCase() + marker.type.slice(1);
      inline.children = [];

      const body: Token[] = [];
      if (marker.rest.trim()) {
        const p = new state.Token("paragraph_open", "p", 1);
        const c = new state.Token("inline", "", 0);
        const pc = new state.Token("paragraph_close", "p", -1);
        p.level = c.level = pc.level = open.level + 1;
        p.block = c.block = pc.block = true;
        c.content = marker.rest;
        c.children = [];
        body.push(p, c, pc);
      }
      const hasBody = body.length > 0 || close > i + 4;
      if (!hasBody) continue;
      const contentOpen = new state.Token("callout_content_open", "div", 1);
      contentOpen.attrSet("class", "callout-content");
      contentOpen.block = true;
      contentOpen.level = open.level + 1;
      const contentClose = new state.Token("callout_content_close", "div", -1);
      contentClose.block = true;
      contentClose.level = open.level + 1;
      tokens.splice(close, 0, contentClose);
      tokens.splice(i + 4, 0, contentOpen, ...body);
    }
  });
}
