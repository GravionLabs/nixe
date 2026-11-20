/** Pure helpers of the note composer (#113): extract text into a note, merge a note into another. */

import type { ComposeChange } from "../file/backend";

/** 1-based line of the heading that holds `line`: the last ATX heading at or above it, outside code fences and frontmatter. */
export function headingLineAt(text: string, line: number): number | null {
  const lines = text.split("\n");
  let found: number | null = null;
  let fence: { char: string; length: number } | null = null;
  let start = 0;
  if (lines[0]?.trimEnd() === "---") {
    const close = lines.findIndex(
      (l, i) => i > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."),
    );
    if (close > 0) start = close + 1;
  }
  for (let i = start; i < Math.min(line, lines.length); i++) {
    const raw = lines[i].replace(/\r$/u, "");
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(raw);
    if (fence) {
      if (open && open[1][0] === fence.char && open[1].length >= fence.length && !open[2].trim())
        fence = null;
      continue;
    }
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/u.test(raw) && raw.replace(/[#\s]/gu, "")) found = i + 1;
  }
  return found;
}

/** The text of the heading on `line` of `text`, without `#` marks; "" when there is none. */
export function headingTextAt(text: string, line: number): string {
  const raw = (text.split("\n")[line - 1] ?? "").replace(/\r$/u, "");
  return raw
    .replace(/^ {0,3}#{1,6}[ \t]*/u, "")
    .replace(/[ \t]+#+[ \t]*$/u, "")
    .trim();
}

const INVALID_NAME_CHARS = /[\\:*?"<>|#^[\]]/gu;

/**
 * The vault-relative path of the note the user typed: folders by `/`, `.md` added, characters that
 * are invalid in file names dropped. A name without a folder goes to `folder`. Null when empty.
 */
export function targetNotePath(typed: string, folder: string): string | null {
  const parts = typed
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.replace(INVALID_NAME_CHARS, "").trim())
    .filter((p) => p && p !== "." && p !== "..");
  const last = parts.pop();
  if (!last) return null;
  const name = /\.md$/iu.test(last) ? last : `${last}.md`;
  const folders =
    typed.includes("/") || typed.includes("\\") ? parts : [...folder.split("/").filter(Boolean)];
  return [...folders, name].join("/");
}

const VERB: Record<ComposeChange["action"], string> = {
  create: "new note",
  append: "text added",
  update: "updated",
  trash: "moved to .trash/",
};

/** The text of the confirmation: every note that changes, at most `limit` lines. */
export function describeChanges(changes: readonly ComposeChange[], limit = 12): string {
  const lines = changes.slice(0, limit).map((c) => {
    const links = c.links > 0 ? `, ${c.links} link${c.links === 1 ? "" : "s"}` : "";
    return `• ${c.path} (${VERB[c.action]}${links})`;
  });
  if (changes.length > lines.length) lines.push(`… and ${changes.length - lines.length} more`);
  return lines.join("\n");
}
