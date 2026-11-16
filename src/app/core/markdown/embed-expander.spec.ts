// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { expandEmbeds, type EmbedDeps } from "./embed-expander";

const notes: Record<string, string> = {
  "Note.md": "# Note\n\nIntro\n\n## Second\n\nsecond text\n\nblock text ^b1\n",
  "A.md": "A start\n\n![[B]]",
  "B.md": "B start\n\n![[A]]",
  "L1.md": "![[L2]]",
  "L2.md": "![[L3]]",
  "L3.md": "![[L4]]",
  "L4.md": "deep",
  "Dup.md": "- [ ] milk\n\n- [ ] milk ^b1\n",
};
const embed = (t: string) =>
  `<div class="embed" data-embed="${t}"><div class="embed-title"></div><div class="embed-body"></div></div>`;
const deps: EmbedDeps = {
  vaultRoot: "/v",
  vaultFiles: Object.keys(notes),
  read: async (p) => notes[p.slice(3)],
  // trivial renderer: nested embeds survive as placeholders
  render: (text) => text.replace(/!\[\[(.+?)\]\]/g, (_, t) => embed(t)).replace(/\n/g, " "),
};
const runDup = async () => {
  const root = document.createElement("div");
  root.innerHTML = embed("Dup#^b1");
  await expandEmbeds(root, deps, ["Doc.md"]);
  return root;
};
const run = async (target: string, current = "Doc.md") => {
  const root = document.createElement("div");
  root.innerHTML = embed(target);
  await expandEmbeds(root, deps, [current]);
  return root;
};

describe("expandEmbeds", () => {
  it("embeds a note, a heading and a block", async () => {
    expect((await run("Note")).textContent).toContain("Intro");
    const heading = (await run("Note#Second")).textContent!;
    expect(heading).toContain("second text");
    expect(heading).not.toContain("Intro");
    const block = (await run("Note#^b1")).textContent!;
    expect(block).toContain("block text");
    expect(block).not.toContain("^b1");
  });
  it("renders a placeholder for a cycle", async () => {
    const root = await run("A");
    expect(root.textContent).toContain("Embed cycle: A.md");
    expect(root.textContent).toContain("B start");
  });
  it("renders a placeholder when the note embeds itself via the current note", async () => {
    expect((await run("A", "A.md")).textContent).toContain("Embed cycle: A.md");
  });
  it("stops at depth 3", async () => {
    const root = await run("L1");
    expect(root.textContent).toContain("Embed too deep: L4.md");
    expect(root.textContent).not.toContain("deep ");
  });
  it("reports missing notes and sections", async () => {
    expect((await run("Nope")).textContent).toContain("Note not found");
    expect((await run("Note#Zzz")).textContent).toContain("Section not found");
  });

  it("records the file and line offset of an embedded section for its checkboxes", async () => {
    const el = (await run("Note#Second")).querySelector<HTMLElement>(".embed-body")!;
    expect(el.dataset["sourcePath"]).toBe("/v/Note.md");
    expect(el.dataset["lineOffset"]).toBe("4");
    const whole = (await run("Note")).querySelector<HTMLElement>(".embed-body")!;
    expect(whole.dataset["lineOffset"]).toBe("0");
    const dup = (await runDup()).querySelector<HTMLElement>(".embed-body")!;
    expect(dup.dataset["lineOffset"]).toBe("2");
  });
});
