// Minimal path helpers that work for POSIX and Windows paths inside the
// webview (no Node "path" module available). Paths are normalized to "/".

const DRIVE_RE = /^[A-Za-z]:\//;

export function toSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isAbsolutePath(p: string): boolean {
  const s = toSlashes(p);
  return s.startsWith("/") || DRIVE_RE.test(s);
}

export function dirname(p: string): string {
  const s = toSlashes(p).replace(/\/+$/, "");
  const idx = s.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  const dir = s.slice(0, idx);
  return /^[A-Za-z]:$/.test(dir) ? dir + "/" : dir;
}

export function basename(p: string): string {
  const s = toSlashes(p).replace(/\/+$/, "");
  return s.slice(s.lastIndexOf("/") + 1);
}

export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx).toLowerCase() : "";
}

/** Joins and normalizes path segments, resolving "." and "..". */
export function joinPath(base: string, ...parts: string[]): string {
  const segments = [base, ...parts].filter(Boolean).map(toSlashes);
  const isUnc = segments[0]?.startsWith("//") ?? false;
  let s = segments.join("/");

  let prefix = "";
  const drive = s.match(/^[A-Za-z]:\//);
  if (drive) {
    prefix = drive[0];
    s = s.slice(prefix.length);
  } else if (isUnc) {
    prefix = "//"; // UNC path (\\server\share)
    s = s.slice(2);
  } else if (s.startsWith("/")) {
    prefix = "/";
    s = s.slice(1);
  }

  const out: string[] = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!prefix) out.push("..");
    } else {
      out.push(seg);
    }
  }
  return prefix + out.join("/");
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);

export function isMarkdownPath(p: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(p));
}
