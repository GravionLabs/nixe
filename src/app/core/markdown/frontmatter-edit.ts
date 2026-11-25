import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Pair,
  type YAMLSeq,
} from "yaml";

/** One change of the properties panel, applied to the note text. */
export type PropertyEdit =
  | { kind: "set"; key: string; value: unknown }
  | { kind: "rename"; from: string; to: string }
  | { kind: "remove"; key: string }
  /** One place up (-1) or down (1) among the properties. */
  | { kind: "move"; key: string; direction: -1 | 1 };

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
    throw new Error(
      `The value of "${String(keyOf(pair))}" is referenced by an alias and cannot be changed here.`,
    );
  }
}

/** `key: value` as YAML, one entry, without the trailing newline. A long text is not folded. */
function entry(key: string, value: unknown): string {
  return stringify({ [key]: value }, { lineWidth: 0 }).replace(/\n$/, "");
}

/** The entry that replaces `old`: a quoted text stays quoted, a `[a, b]` list stays one line. */
function replacement(key: string, value: unknown, old: unknown, yamlText: string): string {
  const quoted =
    typeof value === "string" &&
    isScalar(old) &&
    (old.type === "QUOTE_DOUBLE" || old.type === "QUOTE_SINGLE");
  const flow = Array.isArray(value) && isSeq(old) && old.flow === true;
  if (!quoted && !flow) return entry(key, value);
  const doc = new Document({});
  const node = doc.createNode(value, { flow });
  if (quoted && isScalar(node)) node.type = (old as { type: "QUOTE_DOUBLE" | "QUOTE_SINGLE" }).type;
  doc.set(key, node);
  const range = (old as { range: [number, number, number] }).range;
  const flowCollectionPadding = /^\[\s/.test(yamlText.slice(range[0], range[1]));
  return doc.toString({ lineWidth: 0, flowCollectionPadding }).replace(/\n$/, "");
}

/**
 * The lines of a block list (`- item` per line) changed to hold `value`: lines of items that stay
 * and the comment lines between items are kept, other items are dropped, new ones are added after
 * the last one. Null when the list cannot be changed line by line.
 */
function blockList(
  yamlText: string,
  from: number,
  old: YAMLSeq,
  value: unknown[],
): { text: string; end: number } | null {
  if (old.flow || !old.items.length || !value.length) return null;
  const items: { start: number; end: number; value: unknown }[] = [];
  for (const item of old.items) {
    if (!isScalar(item) || !item.range) return null;
    const start = yamlText.lastIndexOf("\n", item.range[0] - 1) + 1;
    if (!/^[ \t]*-[ \t]/.test(yamlText.slice(start, item.range[0]))) return null;
    const nl = yamlText.indexOf("\n", Math.max(item.range[1] - 1, item.range[0]));
    items.push({ start, end: nl < 0 ? yamlText.length : nl + 1, value: item.value });
  }
  const eol = yamlText.includes("\r\n") ? "\r\n" : "\n";
  const indent = /^[ \t]*/.exec(yamlText.slice(items[0]!.start))![0];
  let out = "";
  let at = from;
  let next = 0;
  for (const item of items) {
    out += yamlText.slice(at, item.start);
    if (next < value.length && Object.is(item.value, value[next])) {
      out += yamlText.slice(item.start, item.end);
      next++;
    }
    at = item.end;
  }
  if (out && !out.endsWith("\n")) out += eol;
  for (const added of value.slice(next)) {
    const written = stringify([added], { lineWidth: 0 }).replace(/\n$/, "");
    out += `${indent}${written.replace(/\n/g, `${eol}${indent}`)}${eol}`;
  }
  return { text: out, end: at };
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
  if (root !== null && !isMap(root))
    throw new Error("Frontmatter must be a YAML mapping (key: value).");
  const isBlock = root === null || !root.flow;
  const pairs = root?.items ?? [];
  const find = (key: string): Pair | undefined => pairs.find((p) => keyOf(p) === key);
  const splice = (from: number, to: number, insert: string): string =>
    text.slice(0, block.start + from) + insert + text.slice(block.start + to);
  const lines = (s: string): string => s.replace(/\n/g, eol);

  if (!isBlock) return flowFallback(text, block, doc, edit, eol);

  if (edit.kind === "move") return moveBlock(text, block, pairs, edit, yamlText);

  const pair =
    edit.kind === "set" ? find(edit.key) : find(edit.kind === "rename" ? edit.from : edit.key);

  switch (edit.kind) {
    case "set": {
      if (!pair) {
        const sep = yamlText === "" || yamlText.endsWith("\n") ? "" : eol;
        return splice(
          yamlText.length,
          yamlText.length,
          `${sep}${lines(entry(edit.key, edit.value))}${eol}`,
        );
      }
      guardAnchor(pair, yamlText);
      const keyRange = (pair.key as { range: [number, number, number] }).range;
      const valueRange = (pair.value as { range?: [number, number, number] } | null)?.range;
      if (isSeq(pair.value) && Array.isArray(edit.value)) {
        const list = blockList(yamlText, keyRange[0], pair.value, edit.value);
        if (list) return splice(keyRange[0], list.end, list.text);
      }
      const written = lines(replacement(edit.key, edit.value, pair.value, yamlText));
      if (!valueRange || valueRange[1] === valueRange[0]) {
        // `key:` without a value: replace through the colon and keep what follows (a comment).
        const end = yamlText.indexOf(":", keyRange[1]) + 1;
        const next = yamlText[end];
        return splice(
          keyRange[0],
          end,
          next === undefined || /[ \t\r\n]/.test(next) ? written : `${written} `,
        );
      }
      return splice(keyRange[0], lineContentEnd(yamlText, valueRange[1]), written);
    }
    case "rename": {
      if (!pair) return text;
      if (edit.to !== edit.from && find(edit.to))
        throw new Error(`The property "${edit.to}" already exists.`);
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

/** True when the YAML parses and every alias has its anchor before it. */
function parsesWithAliases(yamlText: string): boolean {
  const doc = parseDocument(yamlText);
  if (doc.errors.length) return false;
  try {
    doc.toJS();
    return true;
  } catch {
    return false;
  }
}

/** Swaps the lines of the property with those of its neighbour; nothing else changes. */
function moveBlock(
  text: string,
  block: Block,
  pairs: Pair[],
  edit: { key: string; direction: -1 | 1 },
  yamlText: string,
): string {
  const i = pairs.findIndex((p) => keyOf(p) === edit.key);
  const j = i + edit.direction;
  if (i < 0 || j < 0 || j >= pairs.length) return text;
  const keyLine = (p: Pair): number =>
    yamlText.lastIndexOf("\n", (p.key as { range: [number, number, number] }).range[0] - 1) + 1;
  // A comment block directly above a key belongs to it and moves with it.
  const lineStart = (k: number): number => {
    let at = keyLine(pairs[k]);
    const floor = k > 0 ? keyLine(pairs[k - 1]) : 0;
    while (at > floor) {
      const prev = yamlText.lastIndexOf("\n", at - 2) + 1;
      if (prev <= floor || !/^\s*#/.test(yamlText.slice(prev, at))) break;
      at = prev;
    }
    return at;
  };
  const lo = Math.min(i, j);
  const a = lineStart(lo);
  const b = lineStart(lo + 1);
  let c: number;
  if (lo + 2 < pairs.length) c = lineStart(lo + 2);
  else {
    const last = pairs[lo + 1];
    const keyEnd = (last.key as { range: [number, number, number] }).range[1];
    const valueRange = (last.value as { range?: [number, number, number] } | null)?.range;
    const valueEnd = valueRange ? lineContentEnd(yamlText, valueRange[1]) : keyEnd + 1;
    const nl = yamlText.indexOf("\n", Math.max(valueEnd - 1, keyEnd));
    c = nl < 0 ? yamlText.length : nl + 1;
  }
  const swapped =
    yamlText.slice(0, a) + yamlText.slice(b, c) + yamlText.slice(a, b) + yamlText.slice(c);
  // An anchor and its alias must not trade places: the result has to stay valid YAML.
  if (!parsesWithAliases(swapped))
    throw new Error(`"${edit.key}" cannot be moved here: an alias would come before its anchor.`);
  return text.slice(0, block.start) + swapped + text.slice(block.end);
}

/** A flow mapping (`{a: 1}`) has no lines of its own: the document is written again. */
function flowFallback(
  text: string,
  block: Block,
  doc: ReturnType<typeof parseDocument>,
  edit: PropertyEdit,
  eol: string,
): string {
  switch (edit.kind) {
    case "set":
      doc.set(edit.key, edit.value);
      break;
    case "remove":
      doc.delete(edit.key);
      break;
    case "move": {
      const map = doc.contents;
      if (!isMap(map)) return text;
      const i = map.items.findIndex((p) => keyOf(p) === edit.key);
      const j = i + edit.direction;
      if (i < 0 || j < 0 || j >= map.items.length) return text;
      [map.items[i], map.items[j]] = [map.items[j], map.items[i]];
      break;
    }
    case "rename": {
      const map = doc.contents;
      if (!isMap(map)) return text;
      const pair = map.items.find((p) => keyOf(p) === edit.from);
      if (!pair) return text;
      if (edit.to !== edit.from && map.has(edit.to))
        throw new Error(`The property "${edit.to}" already exists.`);
      pair.key = doc.createNode(edit.to);
      break;
    }
  }
  const out = doc.toString().replace(/\n/g, eol);
  return text.slice(0, block.start) + out + text.slice(block.end);
}
