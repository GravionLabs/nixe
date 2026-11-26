// @ts-check
import angular from "angular-eslint";
import tseslint from "typescript-eslint";
import { readFileSync } from "node:fs";
import helix, { helixAllow } from "@gravionlabs/helix-lint/eslint";

// Exceptions to the helix-lint preset, each with a reason (#695): scripts/lint/helix-allow.json.
const allow = JSON.parse(
  readFileSync(new URL("./scripts/lint/helix-allow.json", import.meta.url), "utf8"),
);

/**
 * ESLint lints the Angular templates only; oxlint lints every .ts file, including the Angular class
 * rules (`.oxlintrc.json`, ADR 0006 of GravionLabs/skills). Every component template is a .html file
 * (#273), so no inline-template processor is needed.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "extension/dist/**",
      "coverage/**",
      "node_modules/**",
      ".angular/**",
      "out-tsc/**",
      "src-tauri/**",
      ".agents/**",
      ".claude/**",
      "docs/**",
      "fixtures/**",
      // The lint probe holds deliberate violations; src/testing/lint-probe.spec.ts lints it.
      "src/testing/lint-probe/**",
    ],
  },
  {
    files: ["src/**/*.html"],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
  // helix/no-raw-control (#695): no native button, input, select, textarea or progress in a template.
  ...helix,
  ...allow.eslint.map((entry) => helixAllow(entry)),
);
