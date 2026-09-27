import { dirname, isAbsolutePath, isMarkdownPath, joinPath } from "./paths";

export type LinkTarget =
  | { kind: "none" }
  | { kind: "anchor"; anchor: string }
  | { kind: "external"; url: string }
  | { kind: "local"; path: string; anchor: string | null };

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Classifies the raw href of a clicked link. */
export function classifyHref(href: string | null | undefined): LinkTarget {
  const raw = (href ?? "").trim();
  if (!raw) return { kind: "none" };
  if (raw.startsWith("#")) return { kind: "anchor", anchor: safeDecode(raw.slice(1)) };

  const scheme = raw.match(SCHEME_RE)?.[1]?.toLowerCase();
  // A single letter "scheme" is a Windows drive letter (C:/…).
  if (scheme && scheme.length > 1) {
    if (EXTERNAL_SCHEMES.has(scheme)) return { kind: "external", url: raw };
    if (scheme === "file") {
      const path = safeDecode(raw.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1"));
      return { kind: "local", path, anchor: null };
    }
    return { kind: "none" }; // javascript:, data:, … are ignored
  }

  const hashIdx = raw.indexOf("#");
  const pathPart = (hashIdx >= 0 ? raw.slice(0, hashIdx) : raw).replace(/\?.*$/, "");
  const anchor = hashIdx >= 0 ? safeDecode(raw.slice(hashIdx + 1)) || null : null;
  if (!pathPart) return anchor ? { kind: "anchor", anchor } : { kind: "none" };
  return { kind: "local", path: pathPart, anchor };
}

/**
 * Candidate spellings for a (still URL-encoded) link path.
 * Azure DevOps wiki links encode spaces as "-" and real hyphens as "%2D";
 * in wiki repositories the files keep that encoding ("Q%2DA.md").
 */
export function nameVariants(encoded: string): string[] {
  const plain = safeDecode(encoded);
  const ado = safeDecode(encoded.replace(/-/g, " "));
  return [...new Set([plain, ado, encoded])];
}

export interface ResolveContext {
  /** Absolute path of the currently displayed file. */
  currentFile: string;
  /** Root used for links starting with "/" (Azure DevOps wiki root). */
  wikiRoot: string;
  exists: (path: string) => Promise<boolean>;
}

/**
 * Resolves a local link path to an existing file, trying (in order):
 * relative/wiki-root/absolute bases × plain/ADO name variants × with/without ".md".
 */
export async function resolveLocalLink(
  linkPath: string,
  ctx: ResolveContext,
): Promise<string | null> {
  for (const candidate of localCandidates(linkPath, ctx)) {
    if (await ctx.exists(candidate)) return candidate;
  }
  return null;
}

export function localCandidates(linkPath: string, ctx: Omit<ResolveContext, "exists">): string[] {
  const bases: string[] = [];
  if (linkPath.startsWith("/")) {
    bases.push(ctx.wikiRoot, ""); // wiki-root relative first, then real absolute path
  } else if (isAbsolutePath(linkPath)) {
    bases.push("");
  } else {
    bases.push(dirname(ctx.currentFile));
  }

  const result: string[] = [];
  for (const base of bases) {
    for (const name of nameVariants(linkPath)) {
      const full = joinPath(base, name);
      // Page names may contain dots ("v1.2 Release"), so ".md" is always tried first.
      if (!isMarkdownPath(full)) result.push(full + ".md");
      result.push(full);
    }
  }
  return [...new Set(result)];
}
