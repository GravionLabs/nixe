import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import { autocompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import type {
  BlockRef,
  HeadingRef,
  PlainOption,
  WikilinkStage,
} from "../../core/editor/completion-core";
import {
  blockOptions,
  headingOptions,
  noteOptions,
  tagOptions,
  tagStage,
  wikilinkStage,
} from "../../core/editor/completion-core";
import type { LinkFormat, TagCount } from "../../core/file/backend";
import type { SwitcherEntry } from "../../core/switcher/fuzzy";
import { inCode } from "./editor-extensions";

/** What the completion needs to know about the vault; the editor component supplies it. */
export interface CompletionData {
  /** Notes of the vault with their aliases. */
  notes(): Promise<SwitcherEntry[]>;
  /** The open note, vault-relative; null when it is outside the vault. */
  currentPath(): string | null;
  linkFormat(): Promise<LinkFormat["format"]>;
  /** Headings of a note: `note` is the typed link target, empty for the open note. */
  headings(note: string, openText: string): Promise<HeadingRef[]>;
  blocks(note: string, openText: string): Promise<BlockRef[]>;
  /** Tags of the vault, most used first. */
  tags(): Promise<TagCount[]>;
}

/** Replaces `from..to` and closes the link with `]]` unless it is closed already. */
function applyLink(insert: string, close: boolean): Completion["apply"] {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const after = view.state.doc.sliceString(to, to + 2);
    const tail = close && after !== "]]" ? "]]" : "";
    const text = insert + tail;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + insert.length + (close ? 2 : 0) },
      userEvent: "input.complete",
    });
  };
}

function toCompletions(options: readonly PlainOption[], close: boolean): Completion[] {
  return options.map((o) => ({
    label: o.label,
    detail: o.detail,
    apply: applyLink(o.insert, close),
  }));
}

function result(from: number, options: Completion[]): CompletionResult | null {
  return options.length ? { from, options, filter: false } : null;
}

/** `[[`: notes, `[[Note#`: headings, `[[Note#^`: block ids. */
export function wikilinkSource(data: CompletionData): CompletionSource {
  return async (context: CompletionContext) => {
    const line = context.state.doc.lineAt(context.pos);
    const stage = wikilinkStage(line.text, context.pos - line.from);
    if (!stage || inCode(context.state, context.pos)) return null;
    const options = await stageOptions(data, stage, context);
    if (context.aborted || !options) return null;
    return result(line.from + stage.from, options);
  };
}

async function stageOptions(
  data: CompletionData,
  stage: WikilinkStage,
  context: CompletionContext,
): Promise<Completion[] | null> {
  const doc = context.state.doc.toString();
  switch (stage.kind) {
    case "note": {
      const [entries, format] = await Promise.all([data.notes(), data.linkFormat()]);
      return toCompletions(noteOptions(entries, stage.query, format, data.currentPath()), true);
    }
    case "heading":
      return toCompletions(headingOptions(await data.headings(stage.note, doc), stage.query), true);
    case "block":
      return toCompletions(blockOptions(await data.blocks(stage.note, doc), stage.query), true);
  }
}

/** `#` at a word start: the tags of the vault by frequency. */
export function tagSource(data: CompletionData): CompletionSource {
  return async (context: CompletionContext) => {
    const line = context.state.doc.lineAt(context.pos);
    const stage = tagStage(line.text, context.pos - line.from);
    if (!stage || inCode(context.state, context.pos)) return null;
    const options = toCompletions(tagOptions(await data.tags(), stage.query), false);
    if (context.aborted) return null;
    return result(line.from + stage.from, options);
  };
}

export function completionExtension(data: CompletionData): Extension {
  return autocompletion({ override: [wikilinkSource(data), tagSource(data)], icons: false });
}
