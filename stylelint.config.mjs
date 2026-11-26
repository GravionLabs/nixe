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
  // Next to the preset (#695): component CSS styles no native control (the Helix directive owns
  // its look), and the `font` shorthand must not carry a px or rem size (the preset checks only
  // `font-size`).
  rules: {
    // A type selector only: not `.button`, `#input`, `hx-select` or an attribute value.
    "selector-disallowed-list": [/(^|[\s>+~(,])(button|input|select|textarea|progress)(?![\w-])/i],
    "declaration-property-value-disallowed-list": { font: [/\d(px|rem)\b/i] },
  },
  ignoreFiles: ["dist/**", "node_modules/**", ".angular/**", "src-tauri/**", "extension/**"],
  overrides: allow.stylelint.map((entry) => helixAllow(entry)),
};
