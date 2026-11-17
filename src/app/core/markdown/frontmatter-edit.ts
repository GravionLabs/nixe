import { isMap, isScalar, parseDocument, stringify, type Pair } from "yaml";

/** One change of the properties panel, applied to the note text. */
export type PropertyEdit =
  | { kind: "set"; key: string; value: unknown }
  | { kind: "rename"; from: string; to: string }
  | { kind: "remove"; key: string };

interface Block {
  /** Offset of the first character after the opening fence line. */
  start: number;
  /** Offset of the closing fence line. */
  end: number;
}

const FENCE = /^---[ \t]*$/;

/** Offsets of the YAML between the fences; null when the note has no frontmatter. */
function locate(text: string): Block | null {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let offset = bom;
  let first = true;
  let start = 0;
  while (offset <= text.length) {
    const nl = text.indexOf("\n", offset);
    const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(offset, lineEnd).replace(/\r$/, "");
    if (first) {
      if (!FENCE.test(line)) return null;
      start = nl < 0 ? text.length : nl + 1;
      first = false;
    } else if (FENCE.test(line) || line === "...") {
      return { start, end: offset };
    }
    if (nl < 0) return null;
    offset = nl + 1;
  }
  return null;
}

const keyOf = (pair: Pair): string | null =>
  isScalar(pair.key) && typeof pair.key.value === "string" ? pair.key.value : null;

/** A block value's range ends after its last newline; the content ends before it. */
function lineContentEnd(yamlText: string, end: number): number {
  let e = end;
  if (yamlText[e - 1] === "\n") e--;
  if (yamlText[e - 1] === "\r") e--;
  return e;
}

/** Replacing or removing an anchored value would leave its aliases without a target. */
function guardAnchor(pair: Pair, yamlText: string): void {
  const anchor = (pair.value as { anchor?: string } | null)?.anchor;
  if (anchor && yamlText.includes(`*${anchor}`)) {
    throw new Error(`The value of "${String(keyOf(pair))}" is referenced by an alias and cannot be changed here.`);
  }
}

/** `key: value` as YAML, one entry, without the trailing newline. */
function entry(key: string, value: unknown): string {
  return stringify({ [key]: value }).replace(/\n$/, "");
}

/**
 * Applies `edit` to the frontmatter of `text` and returns the new note text. Only the lines of the
 * edited key change: key order, comments and the formatting of the other keys stay byte for byte.
 * A note without frontmatter gets one for a `set`. Throws when the frontmatter is not a valid
 * YAML mapping, or when a rename would collide with an existing key.
 */
export function editFrontmatter(text: string, edit: PropertyEdit): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = locate(text);

  if (!block) {
    if (edit.kind !== "set") return text;
    const bom = text.charCodeAt(0) === 0xfeff ? "﻿" : "";
    return `${bom}---${eol}${entry(edit.key, edit.value).replace(/\n/g, eol)}${eol}---${eol}${text.slice(bom.length)}`;
  }

  const yamlText = text.slice(block.start, block.end);
  const doc = parseDocument(yamlText);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const root = doc.contents;
  if (root !== null && !isMap(root)) throw new Error("Frontmatter must be a YAML mapping (key: value).");
  const isBlock = root === null || !root.flow;
  const pairs = root?.items ?? [];
  const find = (key: string): Pair | undefined => pairs.find((p) => keyOf(p) === key);
  const splice = (from: number, to: number, insert: string): string =>
    text.slice(0, block.start + from) + insert + text.slice(block.start + to);
  const lines = (s: string): string => s.replace(/\n/g, eol);

  if (!isBlock) return flowFallback(text, block, doc, edit, eol);

  const pair = edit.kind === "set" ? find(edit.key) : edit.kind === "rename" ? find(edit.from) : find(edit.key);

  switch (edit.kind) {
    case "set": {
      if (!pair) {
        const sep = yamlText === "" || /\n$/.test(yamlText) ? "" : eol;
        return splice(yamlText.length, yamlText.length, `${sep}${lines(entry(edit.key, edit.value))}${eol}`);
      }
      guardAnchor(pair, yamlText);
      const keyRange = (pair.key as { range: [number, number, number] }).range;
      const valueRange = (pair.value as { range?: [number, number, number] } | null)?.range;
      const written = lines(entry(edit.key, edit.value));
      if (!valueRange || valueRange[1] === valueRange[0]) {
        // `key:` without a value: replace through the colon and keep what follows (a comment).
        const end = yamlText.indexOf(":", keyRange[1]) + 1;
        const next = yamlText[end];
        return splice(keyRange[0], end, next === undefined || /[ \t\r\n]/.test(next) ? written : `${written} `);
      }
      return splice(keyRange[0], lineContentEnd(yamlText, valueRange[1]), written);
    }
    case "rename": {
      if (!pair) return text;
      if (edit.to !== edit.from && find(edit.to)) throw new Error(`The property "${edit.to}" already exists.`);
      const range = (pair.key as { range: [number, number, number] }).range;
      return splice(range[0], range[1], stringify(edit.to).replace(/\n$/, ""));
    }
    case "remove": {
      if (!pair) return text;
      guardAnchor(pair, yamlText);
      const keyRange = (pair.key as { range: [number, number, number] }).range;
      const valueRange = (pair.value as { range?: [number, number, number] } | null)?.range;
      const valueEnd = valueRange ? lineContentEnd(yamlText, valueRange[1]) : keyRange[1] + 1;
      const from = yamlText.lastIndexOf("\n", keyRange[0] - 1) + 1;
      const nl = yamlText.indexOf("\n", Math.max(valueEnd - 1, keyRange[1]));
      return splice(from, nl < 0 ? yamlText.length : nl + 1, "");
    }
  }
}

/** A flow mapping (`{a: 1}`) has no lines of its own: the document is written again. */
function flowFallback(text: string, block: Block, doc: ReturnType<typeof parseDocument>, edit: PropertyEdit, eol: string): string {
  switch (edit.kind) {
    case "set":
      doc.set(edit.key, edit.value);
      break;
    case "remove":
      doc.delete(edit.key);
      break;
    case "rename": {
      const map = doc.contents;
      if (!isMap(map)) return text;
      const pair = map.items.find((p) => keyOf(p) === edit.from);
      if (!pair) return text;
      if (edit.to !== edit.from && map.has(edit.to)) throw new Error(`The property "${edit.to}" already exists.`);
      pair.key = doc.createNode(edit.to);
      break;
    }
  }
  const out = doc.toString().replace(/\n/g, eol);
  return text.slice(0, block.start) + out + text.slice(block.end);
}
