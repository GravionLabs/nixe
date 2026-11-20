/** A `.css` file of `themes/` or `snippets/` in the app config directory, as `read_appearance` returns it. */
export interface CssFile {
  /** File name without `.css`. */
  name: string;
  /** Modification time (ms); changes when the file changes. */
  modified: number;
  css: string;
}

export type CssKind = "themes" | "snippets";

/** Poll interval for changed theme and snippet files. */
export const RELOAD_MS = 2000;

/** Largest accepted font setting. */
const MAX_FONT = 200;

/** `#rgb` or `#rrggbb`, lowercase; "" when `value` is neither (the default accent applies). */
export function sanitizeAccent(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : "";
}

/**
 * A font family list as typed. Anything that could end the declaration or open a new rule
 * (`;{}<>` and comments, backslashes) makes it empty, so a setting cannot inject CSS.
 */
export function sanitizeFont(value: unknown): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  if (!v || v.length > MAX_FONT || /[;{}<>\\]|\/\*|\*\/|url\(/i.test(v)) return "";
  return v;
}

/** A name from the settings file: a list of strings without duplicates. */
export function sanitizeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v !== ""))];
}

/** The rule for the accent color and the fonts the settings choose; "" when none is set. */
export function overridesCss(accent: string, fontText: string, fontMono: string): string {
  const decl: string[] = [];
  const a = sanitizeAccent(accent);
  if (a) {
    decl.push(`--nixe-accent:${a}`);
    for (const shade of [400, 500, 600, 700]) decl.push(`--h-primary-${shade}:${a}`);
  }
  const text = sanitizeFont(fontText);
  if (text) decl.push(`--nixe-font-text:${text}`);
  const mono = sanitizeFont(fontMono);
  if (mono) decl.push(`--nixe-font-mono:${mono}`);
  return decl.length ? `:root{${decl.join(";")}}` : "";
}

/** The enabled snippets that exist, in the order of the files. Names of missing files are ignored. */
export function enabledSnippets(files: readonly CssFile[], enabled: readonly string[]): CssFile[] {
  const on = new Set(enabled);
  return files.filter((f) => on.has(f.name));
}

/** True when the listed files differ from the applied ones (a name, a time or a content). */
export function changed(before: readonly CssFile[], after: readonly CssFile[]): boolean {
  if (before.length !== after.length) return true;
  return before.some((f, i) => f.name !== after[i].name || f.modified !== after[i].modified || f.css !== after[i].css);
}
