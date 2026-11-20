// @vitest-environment jsdom
import { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { CompletionData, tagSource, wikilinkSource } from "./completion";

const data: CompletionData = {
  notes: async () => [
    { path: "Projects/Roadmap.md", title: "Roadmap", aliases: ["Plan 2026"] },
    { path: "Ideas.md", title: "Ideas", aliases: [] },
  ],
  currentPath: () => "Ideas.md",
  linkFormat: async () => "shortest",
  headings: async (note) =>
    note === "Roadmap" ? [{ level: 1, text: "Goals" }] : [{ level: 1, text: "Mine" }],
  blocks: async () => [{ id: "abc", text: "A block" }],
  tags: async () => [
    { tag: "project", count: 5 },
    { tag: "idea", count: 2 },
  ],
};

/** `doc` with `|` marking the cursor. */
function setup(doc: string) {
  const pos = doc.indexOf("|");
  const text = doc.replace("|", "");
  const state = EditorState.create({
    doc: text,
    selection: { anchor: pos },
    extensions: [markdown()],
  });
  const view = new EditorView({ state, parent: document.body });
  return { view, context: new CompletionContext(state, pos, true) };
}

async function options(source: ReturnType<typeof wikilinkSource>, doc: string) {
  const { context } = setup(doc);
  const result = (await source(context)) as CompletionResult | null;
  return result?.options.map((o) => o.label) ?? null;
}

/** Applies the option labelled `label` and returns the document with `|` at the cursor. */
async function choose(
  source: ReturnType<typeof wikilinkSource>,
  doc: string,
  label: string,
): Promise<string> {
  const { view, context } = setup(doc);
  const result = (await source(context)) as CompletionResult;
  const option = result.options.find((o) => o.label === label)!;
  (option.apply as (v: EditorView, c: unknown, from: number, to: number) => void)(
    view,
    option,
    result.from,
    context.pos,
  );
  const { head } = view.state.selection.main;
  const text = view.state.doc.toString();
  return text.slice(0, head) + "|" + text.slice(head);
}

describe("wikilinkSource", () => {
  const source = wikilinkSource(data);

  it("lists the notes after [[, by fuzzy match", async () => {
    expect(await options(source, "[[|")).toEqual(["Ideas", "Roadmap"]);
    expect(await options(source, "see [[road|")).toEqual(["Roadmap"]);
  });

  it("does not complete elsewhere", async () => {
    expect(await options(source, "plain |")).toBeNull();
    expect(await options(source, "`[[ro|`")).toBeNull();
    expect(await options(source, "[[nothing-like-this|")).toBeNull();
  });

  it("inserts the link and closes it", async () => {
    expect(await choose(source, "a [[road|", "Roadmap")).toBe("a [[Roadmap]]|");
  });

  it("does not close a link that is closed already", async () => {
    expect(await choose(source, "a [[road|]] b", "Roadmap")).toBe("a [[Roadmap]]| b");
  });

  it("inserts Note|Alias for an alias", async () => {
    expect(await options(source, "[[plan|")).toEqual(["Plan 2026"]);
    expect(await choose(source, "[[plan|", "Plan 2026")).toBe("[[Roadmap|Plan 2026]]|");
  });

  it("lists headings and blocks of the named note", async () => {
    expect(await options(source, "[[Roadmap#|")).toEqual(["Goals"]);
    expect(await choose(source, "[[Roadmap#|", "Goals")).toBe("[[Roadmap#Goals]]|");
    expect(await options(source, "[[#|")).toEqual(["Mine"]);
    expect(await options(source, "[[Roadmap#^|")).toEqual(["abc"]);
    expect(await choose(source, "[[Roadmap#^a|", "abc")).toBe("[[Roadmap#^abc]]|");
  });

  it("uses the link format of the vault", async () => {
    const absolute = wikilinkSource({ ...data, linkFormat: async () => "absolute" });
    expect(await choose(absolute, "[[road|", "Roadmap")).toBe("[[Projects/Roadmap]]|");
    const relative = wikilinkSource({
      ...data,
      linkFormat: async () => "relative",
      currentPath: () => "Projects/Deep/Me.md",
    });
    expect(await choose(relative, "[[road|", "Roadmap")).toBe("[[../Roadmap]]|");
  });
});

describe("tagSource", () => {
  const source = tagSource(data);

  it("lists the tags by frequency after a # at a word start", async () => {
    expect(await options(source, "text #|")).toEqual(["project", "idea"]);
    expect(await options(source, "text #id|")).toEqual(["idea"]);
  });

  it("replaces only the typed part and adds no brackets", async () => {
    expect(await choose(source, "x #pr| y", "project")).toBe("x #project| y");
  });

  it("does not complete in a word, a heading or code", async () => {
    expect(await options(source, "a#|")).toBeNull();
    expect(await options(source, "## |")).toBeNull();
    expect(await options(source, "```\n#|\n```")).toBeNull();
  });
});
