import { readFileSync } from "node:fs";
import { helixAllow } from "@gravionlabs/helix-lint/stylelint";

/**
 * Stylelint runs the helix-lint preset over the stylesheets (#695): no hex, rgb or hsl colors,
 * font sizes only from the type scale. Exceptions go in `scripts/lint/helix-allow.json`, each with
 * a reason.
 */
const allow = JSON.parse(
  readFileSync(new URL("./scripts/lint/helix-allow.json", import.meta.url), "utf8"),
);

export default {
  extends: ["@gravionlabs/helix-lint/stylelint"],
  ignoreFiles: ["dist/**", "node_modules/**", ".angular/**", "src-tauri/**", "extension/**"],
  overrides: allow.stylelint.map((entry) => helixAllow(entry)),
};
