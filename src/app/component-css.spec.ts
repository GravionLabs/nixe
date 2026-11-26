import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #694: component stylesheets style no control and take font sizes and colours from the `--h-*` tokens.
// Exceptions are listed with a reason in css-allowlist.json. helix-lint replaces this spec (#695).

type Rule = "control-selector" | "font-size-px" | "colour-literal";

interface Finding {
  file: string;
  rule: Rule;
  /** The selector, the size or the colour that broke the rule. */
  match: string;
}

const allowlist: (Finding & { reason: string })[] = JSON.parse(
  readFileSync(resolve(__dirname, "css-allowlist.json"), "utf8"),
);

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/** The findings of one stylesheet. */
function check(file: string, source: string): Finding[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const found: Finding[] = [];
  const add = (rule: Rule, match: string) => found.push({ file, rule, match });

  // A rule prelude is the text before a `{`, after the end of the previous block or declaration.
  for (const [, prelude] of css.matchAll(/([^{};]+)\{/g)) {
    // Attribute values and brackets may name a control without selecting one.
    const selector = prelude.replace(/\[[^\]]*\]/g, "[]");
    if (/(?<![\w.#-])(button|input|select|textarea)(?![\w-])/i.test(selector))
      add("control-selector", prelude.trim().replace(/\s+/g, " "));
  }

  // Declarations only: a `#add` in a selector is an id, not a colour.
  for (const [, property, value] of css.matchAll(/(?<=[{};]\s*)([-\w]+)\s*:([^{};]*)(?=[;}])/g)) {
    // `font` is the shorthand; a custom property such as `--h-button-sm-font-size` counts too.
    if (/(^|-)font-size$|^font$/.test(property)) {
      for (const [size] of value.matchAll(/(?<![\w.])\d*\.?\d+px\b/gi)) add("font-size-px", size);
    }
    for (const [colour] of value.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/gi))
      add("colour-literal", colour);
  }
  return found;
}

const findings = stylesheets(__dirname).flatMap((path) =>
  check(path.slice(__dirname.length + 1).replaceAll("\\", "/"), readFileSync(path, "utf8")),
);

const same = (a: Finding, b: Finding) =>
  a.file === b.file && a.rule === b.rule && a.match === b.match;

describe("component stylesheets", () => {
  it.each(["control-selector", "font-size-px", "colour-literal"] as const)(
    "have no %s outside the allowlist",
    (rule) => {
      const open = findings.filter((f) => f.rule === rule && !allowlist.some((a) => same(a, f)));
      expect(open).toEqual([]);
    },
  );

  it("need every entry of the allowlist, each with a reason", () => {
    for (const entry of allowlist) {
      expect(entry.reason.trim(), entry.file).not.toBe("");
      expect(
        findings.some((f) => same(f, entry)),
        `${entry.file}: ${entry.match}`,
      ).toBe(true);
    }
  });

  it("report each of the rules", () => {
    const probe = `/* button { color: #fff } */
      .a > button:hover, .b { font-size: 12px; }
      ::ng-deep input.x { color: #2da44e; box-shadow: 0 0 2px rgb(0 0 0 / 0.2); }
      .c { font: 600 13px sans-serif; --h-button-sm-font-size: 9px }`;
    expect(check("probe.css", probe).map((f) => f.match)).toEqual([
      ".a > button:hover, .b",
      "::ng-deep input.x",
      "12px",
      "#2da44e",
      "rgb(0 0 0 / 0.2)",
      "13px",
      "9px",
    ]);
  });

  it("leave Helix elements, classes and attribute values alone", () => {
    const probe = `hx-select, .select, [type="button"] { width: 1px; font-size: var(--h-font-size-sm); }
      #add { color: var(--h-text-color); }`;
    expect(check("probe.css", probe)).toEqual([]);
  });
});
