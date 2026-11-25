// An in-memory vault for the demo backend (#400): the files, a listing like `list_dir`, and the little
// index the side panels need (links, backlinks, tags, search). It is no port of the Rust index, only
// enough of it to show what the app does with the answers.
import { parse } from "yaml";

import type {
  Backlink,
  BaseCell,
  BaseResult,
  DirEntry,
  IndexedLink,
  NoteRecord,
  NoteSummary,
  SearchHit,
  TagCount,
} from "../../app/core/file/backend";

const WIKILINK = /(!?)\[\[([^\]|#^]+)(?:#([^\]|^]*))?(?:\^([^\]|]*))?(?:\|([^\]]*))?\]\]/g;
const TAG = /(?:^|\s)#([A-Za-z][\w/-]*)/g;

const dirname = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const stem = (path: string): string => basename(path).replace(/\.md$/, "");

interface DemoBase {
  filters?: unknown;
  formulas?: unknown;
  properties?: Record<string, { displayName?: string }>;
  views?: { type?: string; name?: string; order?: string[] }[];
}

function demoCell(value: unknown): BaseCell {
  if (value === undefined || value === null) return { type: null, value: null };
  if (Array.isArray(value)) return { type: "list", value };
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "boolean") return { type: "checkbox", value };
  return { type: "text", value };
}

export class DemoVault {
  /** Absolute path → text. */
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  constructor(
    readonly root: string,
    notes: Record<string, string>,
    private readonly modified: number,
  ) {
    this.dirs.add(root);
    for (const [rel, text] of Object.entries(notes)) this.write(`${root}/${rel}`, text);
  }

  isFile(path: string): boolean {
    return this.files.has(path);
  }

  isDir(path: string): boolean {
    return this.dirs.has(path);
  }

  exists(path: string): boolean {
    return this.isFile(path) || this.isDir(path);
  }

  read(path: string): string {
    const text = this.files.get(path);
    if (text === undefined) throw `No such file: ${path}`;
    return text;
  }

  write(path: string, text: string): void {
    for (let dir = dirname(path); dir.length >= this.root.length; dir = dirname(dir)) {
      this.dirs.add(dir);
    }
    this.files.set(path, text);
  }

  makeDir(path: string): void {
    for (let dir = path; dir.length >= this.root.length; dir = dirname(dir)) this.dirs.add(dir);
  }

  /** The vault-relative paths of all files. */
  relativeFiles(): string[] {
    return [...this.files.keys()].map((p) => p.slice(this.root.length + 1)).sort();
  }

  listDir(path: string): DirEntry[] {
    const entries: DirEntry[] = [];
    for (const dir of this.dirs) {
      if (dir !== path && dirname(dir) === path) {
        entries.push({
          name: basename(dir),
          path: dir,
          isDir: true,
          hasOrder: false,
          modified: this.modified,
        });
      }
    }
    for (const file of this.files.keys()) {
      if (dirname(file) === path) {
        entries.push({
          name: basename(file),
          path: file,
          isDir: false,
          hasOrder: false,
          modified: this.modified,
        });
      }
    }
    return entries;
  }

  private notePaths(): string[] {
    return this.relativeFiles().filter((p) => p.endsWith(".md"));
  }

  private title(rel: string): string {
    const text = this.files.get(`${this.root}/${rel}`) ?? "";
    const heading = /^#\s+(.+)$/m.exec(text.replace(/^---\n[\s\S]*?\n---\n/, ""));
    return heading ? heading[1]!.trim() : stem(rel);
  }

  /** The note a link target names, by path or by name; null when there is none. */
  resolve(target: string): string | null {
    const wanted = target.replace(/\.md$/, "");
    return (
      this.notePaths().find((p) => p.replace(/\.md$/, "") === wanted) ??
      this.notePaths().find((p) => stem(p) === basename(wanted)) ??
      null
    );
  }

  notes(): NoteSummary[] {
    return this.notePaths().map((path) => ({ path, title: this.title(path), aliases: [] }));
  }

  links(rel: string): IndexedLink[] {
    const text = this.files.get(`${this.root}/${rel}`) ?? "";
    const lines = text.split("\n");
    const out: IndexedLink[] = [];
    lines.forEach((line, i) => {
      for (const m of line.matchAll(WIKILINK)) {
        out.push({
          target: m[2]!.trim(),
          heading: m[3] ?? null,
          block: m[4] ?? null,
          alias: m[5] ?? null,
          kind: m[1] ? "embed" : "link",
          resolved: this.resolve(m[2]!.trim()),
          line: i + 1,
        });
      }
    });
    return out;
  }

  meta(rel: string): NoteRecord | null {
    if (!this.files.has(`${this.root}/${rel}`)) return null;
    return { path: rel, title: this.title(rel), links: this.links(rel) };
  }

  backlinks(rel: string): Backlink[] {
    const out: Backlink[] = [];
    for (const source of this.notePaths()) {
      const lines = this.read(`${this.root}/${source}`).split("\n");
      for (const link of this.links(source)) {
        if (link.resolved !== rel) continue;
        out.push({
          source,
          heading: link.heading,
          block: link.block,
          alias: link.alias,
          kind: link.kind,
          line: link.line,
          context: (lines[link.line - 1] ?? "").trim(),
        });
      }
    }
    return out;
  }

  tags(): TagCount[] {
    const counts = new Map<string, number>();
    for (const rel of this.notePaths()) {
      const seen = new Set<string>();
      for (const m of this.read(`${this.root}/${rel}`).matchAll(TAG)) seen.add(m[1]!);
      for (const tag of seen) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /** The table of the first table view: `file.name` and note properties, nothing is filtered. */
  baseQuery(source: string): BaseResult {
    const base = (parse(source) ?? {}) as DemoBase;
    const view = base.views?.find((v) => v.type === "table");
    if (!view) throw "The base defines no table view.";
    const ids = (view.order ?? []).filter((id) => !/^(formula\.|file\.(?!name$))/.test(id));
    if (ids.length === 0) ids.push("file.name");
    const key = (id: string) => id.replace(/^note\./, "");
    return {
      view: view.name ?? null,
      columns: ids.map((id) => ({
        id,
        label: base.properties?.[id]?.displayName ?? key(id),
      })),
      rows: this.notePaths().map((path) => {
        const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(this.read(`${this.root}/${path}`));
        const values = (frontmatter ? parse(frontmatter[1]!) : null) ?? {};
        return {
          path,
          cells: ids.map((id): BaseCell =>
            id === "file.name"
              ? { type: "text", value: stem(path) }
              : demoCell((values as Record<string, unknown>)[key(id)]),
          ),
        };
      }),
      unsupported: (["filters", "formulas"] as const).filter((k) => base[k] !== undefined),
    };
  }

  search(query: string): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    for (const rel of this.notePaths()) {
      const snippets = this.read(`${this.root}/${rel}`)
        .split("\n")
        .flatMap((line, i) => {
          const at = line.toLowerCase().indexOf(needle);
          if (at < 0) return [];
          const text = `${line.slice(0, at)}\u0001${line.slice(at, at + needle.length)}\u0002${line.slice(at + needle.length)}`;
          return [{ line: i + 1, text }];
        });
      if (snippets.length) {
        hits.push({
          path: rel,
          title: this.title(rel),
          modified: this.modified,
          matches: snippets.length,
          snippets: snippets.slice(0, 3),
        });
      }
    }
    return hits;
  }
}
