import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";
import { helixAllow as eslintAllow } from "@gravionlabs/helix-lint/eslint";
import { helixAllow as stylelintAllow } from "@gravionlabs/helix-lint/stylelint";
import stylelint from "stylelint";
import { describe, expect, it } from "vitest";

/**
 * #273 (ADR 0006 of GravionLabs/skills): oxlint runs the Angular class rules through an alpha JS
 * plugin and the type-aware rules through oxlint-tsgolint, ESLint runs the template rules.
 * `lint-probe/` holds deliberate violations (left out of `pnpm lint`); this spec lints it and expects
 * every rule, so a plugin, tool or config regression fails here instead of linting nothing.
 */
const PROBE = "src/testing/lint-probe";

interface OxlintReport {
  diagnostics: { code: string; filename: string }[];
}

function oxlint(): string[] {
  let out: string;
  try {
    out = execFileSync("node_modules/.bin/oxlint", ["-f", "json", PROBE], { encoding: "utf8" });
  } catch (error) {
    // oxlint exits 1 when it reports errors; the report is still on stdout.
    out = (error as { stdout: string }).stdout;
  }
  return (JSON.parse(out) as OxlintReport).diagnostics.map(
    (d) => `${d.filename.replace(`${PROBE}/`, "")} ${d.code}`,
  );
}

describe("lint probe", () => {
  it("oxlint reports the Angular class rules, the inline template, the class suffixes and a type-aware rule", () => {
    expect(oxlint().sort()).toEqual([
      "inline-template.component.ts @angular-eslint(component-class-suffix)",
      "inline-template.component.ts @angular-eslint(component-max-inline-declarations)",
      "probe.component.ts @angular-eslint(component-selector)",
      "probe.component.ts @angular-eslint(no-empty-lifecycle-method)",
      "probe.component.ts @angular-eslint(no-output-native)",
      "probe.component.ts @angular-eslint(no-output-on-prefix)",
      "probe.component.ts @angular-eslint(prefer-inject)",
      "probe.component.ts @angular-eslint(prefer-standalone)",
      "probe.component.ts @angular-eslint(use-lifecycle-interface)",
      "probe.component.ts typescript(no-floating-promises)",
      "suffix-probe.directive.ts @angular-eslint(directive-class-suffix)",
    ]);
  }, 60_000);

  it("oxlint reports page.waitForTimeout in the e2e tests (#401)", () => {
    let out: string;
    try {
      out = execFileSync(
        "node_modules/.bin/oxlint",
        ["-f", "json", "e2e/lint/wait-for-timeout.probe.ts"],
        { encoding: "utf8" },
      );
    } catch (error) {
      out = (error as { stdout: string }).stdout;
    }
    expect((JSON.parse(out) as OxlintReport).diagnostics.map((d) => d.code)).toEqual([
      "nixe-e2e(no-wait-for-timeout)",
    ]);
  }, 60_000);

  it("ESLint reports the template rules", async () => {
    const [result] = await new ESLint({ ignore: false }).lintFiles([
      `${PROBE}/probe.component.html`,
    ]);
    expect(result.messages.map((m) => m.ruleId ?? "").sort()).toEqual([
      "@angular-eslint/template/alt-text",
      "@angular-eslint/template/banana-in-box",
      "@angular-eslint/template/click-events-have-key-events",
      "@angular-eslint/template/interactive-supports-focus",
      // The raw <input> and the raw <button> of the probe.
      "helix/no-raw-control",
      "helix/no-raw-control",
    ]);
  }, 60_000);

  it("Stylelint reports a hex color, an off-scale font size, a styled native control and a px font shorthand (#695)", async () => {
    const { results } = await stylelint.lint({ files: `${PROBE}/*.css`, ignorePath: [] });
    const rules = results.flatMap((r) => r.warnings.map((w) => w.rule));
    expect(rules.sort()).toEqual([
      "color-no-hex",
      "declaration-property-value-allowed-list",
      "declaration-property-value-disallowed-list",
      "selector-disallowed-list",
    ]);
  }, 60_000);

  it("every allowlist entry names a reason; an entry without one throws (#695)", () => {
    const allow = JSON.parse(readFileSync("scripts/lint/helix-allow.json", "utf8")) as {
      eslint: { files: string[]; rules: string[]; reason: string }[];
      stylelint: { files: string[]; rules: string[]; reason: string }[];
    };
    for (const entry of [...allow.eslint, ...allow.stylelint]) {
      expect(entry.reason.trim().length).toBeGreaterThan(10);
    }
    const bare = { files: ["src/**"], rules: ["helix/no-raw-control"] };
    expect(() => eslintAllow(bare)).toThrow(/reason/);
    expect(() => stylelintAllow(bare)).toThrow(/reason/);
  });
});
