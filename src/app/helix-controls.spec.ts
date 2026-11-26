import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The panels and toolbars of #693: every control is a Helix primitive, and the component imports its directive
// (a plain `hx-button` attribute without the import would silently render a raw button).
const DIRECTORIES = [
  "features/viewer",
  "features/toolbar",
  "features/terminal",
  "features/health",
  "features/log",
  "features/start",
  "features/compare",
  "features/editor",
  "features/workspace",
  "shared/diff",
  "shared/panel",
];

const DIRECTIVES: Record<string, string> = {
  "hx-button": "HxButton",
  "hx-list-row": "HxListRow",
  "hx-input": "HxInput",
  "hx-radio": "HxRadio",
  "hx-field": "HxField",
  "hx-list": "HxList",
  "hx-tooltip": "HxTooltip",
  "hx-select-button": "HxSelectButton",
};

const templates = DIRECTORIES.flatMap((dir) =>
  readdirSync(resolve(__dirname, dir))
    .filter((file) => file.endsWith(".component.html"))
    .map((file) => join(dir, file)),
);

/** Opening tags, with quoted attribute values kept whole (they may hold `>`). */
const tags = (html: string): string[] => html.match(/<[a-z][\w-]*(?:"[^"]*"|[^>"])*>/g) ?? [];

describe("helix controls of the panels and toolbars", () => {
  it.each(templates)("%s has no raw control and imports its directives", (template) => {
    const found = tags(readFileSync(resolve(__dirname, template), "utf8"));
    const attributes = found.map((tag) => tag.replace(/"[^"]*"/g, '""'));
    const raw = attributes.filter(
      (tag) =>
        /^<(button|input|select|textarea|progress)\b/.test(tag) &&
        !/\shx-(button|list-row|input|radio|checkbox|switch|progress-bar)(?=[\s=/>])/.test(tag),
    );
    expect(raw).toEqual([]);

    const source = readFileSync(resolve(__dirname, template.replace(/\.html$/, ".ts")), "utf8");
    const imports = source.match(/imports: \[([^\]]*)\]/)?.[1] ?? "";
    const missing = Object.entries(DIRECTIVES)
      .filter(([selector]) => {
        const used = new RegExp(`(^<|\\s\\[?)${selector}(?=[\\s=/>\\]])`);
        return attributes.some((tag) => used.test(tag));
      })
      .map(([, directive]) => directive)
      .filter((directive) => !new RegExp(`\\b${directive}\\b`).test(imports));
    expect(missing).toEqual([]);
  });
});
