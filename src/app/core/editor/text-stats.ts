export interface TextStats {
  words: number;
  characters: number;
  /** Whole minutes to read the counted words, at least 1 when there are words. */
  minutes: number;
  /** True when the numbers are of the selection, not of the note. */
  selection: boolean;
}

/** Average silent reading speed. */
export const WORDS_PER_MINUTE = 200;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Removes the frontmatter block at the very top (no YAML parse: this runs while typing). */
function stripFrontmatter(text: string): string {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!/^---[ \t]*\r?\n/.test(source)) return text;
  const close = /\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/g;
  close.lastIndex = source.indexOf("\n");
  const match = close.exec(source);
  return match ? source.slice(match.index + match[0].length) : text;
}

/** Blanks fenced code blocks; an unclosed fence runs to the end, as in Markdown. */
function stripCodeBlocks(text: string): string {
  if (!text.includes("```") && !text.includes("~~~")) return text;
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const match = FENCE_OPEN.exec(line);
    if (fence === null) {
      if (match) fence = match[1];
      else out.push(line);
    } else if (
      match &&
      match[1][0] === fence[0] &&
      match[1].length >= fence.length &&
      line.slice(match[0].length).trim() === ""
    ) {
      fence = null;
    }
  }
  return out.join("\n");
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, " ").replace(/%%[\s\S]*?(?:%%|$)/g, " ");
}

/** Words and characters of the prose: frontmatter, comments and code blocks do not count. */
export function countText(text: string, selection = false): TextStats {
  // A selection is a part: its first line is not the top of the note, so no frontmatter.
  const body = stripComments(stripCodeBlocks(selection ? text : stripFrontmatter(text)));
  const words = body.match(/\S+/g)?.length ?? 0;
  const characters = body.replace(/\s/g, "").length;
  return {
    words,
    characters,
    minutes: words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    selection,
  };
}

/** `1 min read`, or `under a minute` for a short text. */
export function readingTime(stats: TextStats): string {
  if (stats.words === 0) return "Nothing to read";
  const exact = stats.words / WORDS_PER_MINUTE;
  if (exact < 1) return "Reading time: under a minute";
  return `Reading time: ${stats.minutes} min`;
}
