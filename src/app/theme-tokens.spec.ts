import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const tokens = readFileSync(resolve(root, "node_modules/@gravionlabs/helix-ui/tokens.css"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(css|scss|ts)$/.test(name) && !name.endsWith(".spec.ts") ? [path] : [];
  });
}

describe("helix tokens", () => {
  it("are loaded before the app styles", () => {
    const angular = JSON.parse(readFileSync(resolve(root, "angular.json"), "utf8"));
    const styles: string[] = angular.projects.nixe.architect.build.options.styles;
    expect(styles.indexOf("node_modules/@gravionlabs/helix-ui/tokens.css")).toBeGreaterThanOrEqual(
      0,
    );
    expect(styles.indexOf("node_modules/@gravionlabs/helix-ui/tokens.css")).toBeLessThan(
      styles.indexOf("src/styles.scss"),
    );
  });

  it("are the only colour variables: no own chrome variable, no data-theme", () => {
    const own =
      /--(bg|chrome|fg|muted|border|hover|accent|on-accent|toast-bg|toast-fg|error-bg|error-border|error-fg)(?![\w-])/;
    for (const file of sources(resolve(root, "src"))) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(own);
      expect(text, file).not.toContain("data-theme");
    }
  });
});

// WCAG 2.x contrast of the tokens the chrome uses, resolved through `var()` per scheme.
function declarations(scope: "light" | "dark"): Map<string, string> {
  const out = new Map<string, string>();
  const re = scope === "dark" ? /\.app-dark\{([^}]*)\}/g : /:root,:host\{([^}]*)\}/g;
  for (const [, body] of tokens.matchAll(re)) {
    for (const [, name, value] of body.matchAll(/(--h-[a-z0-9-]+):([^;]+);/g))
      out.set(name, value.trim());
  }
  return out;
}

function resolveColor(scope: "light" | "dark", name: string): string {
  const light = declarations("light");
  const dark = declarations("dark");
  let value = `var(${name})`;
  for (let i = 0; i < 10; i++) {
    const m = value.match(/^var\((--h-[a-z0-9-]+)\)$/);
    if (!m) break;
    value = (scope === "dark" ? dark.get(m[1]) : undefined) ?? light.get(m[1]) ?? "";
  }
  return value;
}

/** A `color-mix(in srgb, X, transparent P%)` laid over the page background; any other value as it is. */
function flatten(scope: "light" | "dark", value: string): string {
  const mix = value.match(/^color-mix\(in srgb, var\((--h-[a-z0-9-]+)\), transparent (\d+)%\)$/);
  if (!mix) return value;
  const top = rgb(resolveColor(scope, mix[1]));
  const under = rgb(resolveColor(scope, "--h-content-background"));
  const alpha = 1 - Number(mix[2]) / 100;
  const channel = (i: number) =>
    Math.round(top[i] * alpha + under[i] * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

function rgb(hex: string): number[] {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? [...c].map((x) => x + x).join("") : c;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? [...c].map((x) => x + x).join("") : c;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(["light", "dark"] as const)("contrast in the %s theme", (scope) => {
  const pairs: [string, string][] = [
    ["--h-text-color", "--h-content-background"],
    ["--h-text-color", "--h-surface-frame"],
    ["--h-text-muted-color", "--h-content-background"],
    ["--h-text-muted-color", "--h-surface-frame"],
    ["--h-primary-color", "--h-content-background"],
    ["--h-primary-contrast-color", "--h-primary-color"],
    // The error text is `light-dark(var(--h-red-700), var(--h-red-300))`: the message token is below 4.5:1.
    [scope === "dark" ? "--h-red-300" : "--h-red-700", "--h-message-error-background"],
    ["--h-toast-contrast-color", "--h-toast-contrast-background"],
  ];
  it.each(pairs)("%s on %s is at least 4.5:1", (fg, bg) => {
    const f = resolveColor(scope, fg);
    const b = flatten(scope, resolveColor(scope, bg));
    expect(f, fg).toMatch(/^#[0-9a-f]{3,6}$/i);
    expect(b, bg).toMatch(/^#[0-9a-f]{3,6}$/i);
    expect(contrast(f, b), `${fg} ${f} on ${bg} ${b}`).toBeGreaterThanOrEqual(4.5);
  });
});
