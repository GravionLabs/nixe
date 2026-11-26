// A `.base` file (#630): the tree lists it, a click opens the table tab, a click on a name the note.
// Bases in the live preview (#639): a block and an embed are widgets that switch, sort and edit.
import { readFileSync } from "node:fs";

import { test, expect } from "./fixtures";
import { FAKE_NOTE, FAKE_VAULT } from "./fake-vault";
import { openNote, ready, takeCalls } from "./steps";

const entry = (name: string, path: string) => ({
  name,
  path,
  isDir: false,
  hasOrder: false,
  modified: 0,
});

test("a .base file opens as a table of the notes", async ({ page }) => {
  await ready(page, {
    fake: true,
    script: {
      ...FAKE_VAULT,
      list_dir: [entry("Home.md", FAKE_NOTE), entry("Library.base", "/fake/Notes/Library.base")],
    },
  });
  await page.getByRole("treeitem", { name: "Library.base" }).click();

  await expect(page.getByRole("tab", { name: "Library", selected: true })).toBeVisible();
  const table = page.getByRole("table", { name: "Library.base" });
  await expect(table.getByRole("columnheader", { name: "file.name" })).toBeVisible();

  await table.getByRole("button", { name: "Home" }).click();
  await expect(page.getByRole("tab", { name: "Home", selected: true })).toBeVisible();
});

const note = (name: string, color: string | null) => ({
  path: `${name}.md`,
  cells: [
    { type: "text", value: name },
    { type: "text", value: "A rather long value that has to wrap inside a narrow card" },
  ],
  cover: color ? { type: "color", value: color } : null,
});

test("a cards view shows covers that keep their shape and fit a narrow window", async ({
  page,
}) => {
  await ready(page, {
    fake: true,
    script: {
      ...FAKE_VAULT,
      list_dir: [entry("Home.md", FAKE_NOTE), entry("Library.base", "/fake/Notes/Library.base")],
      base_views: [{ name: "Gallery", type: "cards" }],
      base_query: {
        view: "Gallery",
        columns: [
          { id: "file.name", label: "file.name" },
          { id: "about", label: "About" },
        ],
        rows: [note("Home", "#3366cc"), note("Other", null)],
        grouping: null,
        cards: { image: true, imageFit: "cover", imageAspectRatio: 0.5, cardSize: 800 },
        unsupported: [],
      },
    },
  });
  await page.getByRole("treeitem", { name: "Library.base" }).click();
  const cards = page.getByRole("region", { name: "Library.base" });
  await expect(cards.getByRole("article")).toHaveCount(2);

  for (const width of [1200, 600]) {
    await page.setViewportSize({ width, height: 800 });
    // Never wider than the pane, and the cover is half as high as wide.
    await expect
      .poll(() => cards.evaluate((el) => el.parentElement!.scrollWidth - el.clientWidth))
      .toBeLessThanOrEqual(0);
    const cover = (await cards.locator(".cover").first().boundingBox())!;
    expect(Math.abs(cover.height / cover.width - 0.5)).toBeLessThan(0.02);
  }

  // A click on the cover opens the note.
  // The title lies over it, so the mouse clicks the place, not the element.
  const cover = (await cards.locator(".cover").first().boundingBox())!;
  await page.mouse.click(cover.x + 20, cover.y + 20);
  await expect(page.getByRole("tab", { name: "Home", selected: true })).toBeVisible();
});

test("the live preview shows a base block and an embed as interactive widgets", async ({
  page,
}) => {
  const base = readFileSync("fixtures/vault/Notes.base", "utf8");
  const text = [
    "---",
    "title: Draft",
    "---",
    "",
    "```base",
    "views:",
    "  - type: table",
    "    name: Block",
    "```",
    "",
    "![[Notes.base]]",
    "",
    "The end.",
  ].join("\n");
  await ready(page, {
    fake: true,
    script: {
      ...FAKE_VAULT,
      list_dir: [entry("Home.md", FAKE_NOTE), entry("Notes.base", "/fake/Notes/Notes.base")],
      list_vault_files: ["Home.md", "Notes.base"],
      // Replaced below: the base file of the fixture vault differs from the note.
      read_text_file: text,
      base_views: [
        { name: "All notes", type: "table" },
        { name: "By publication", type: "table" },
      ],
      base_query: {
        view: "All notes",
        columns: [
          { id: "file.name", label: "file.name" },
          { id: "title", label: "Title", property: "title" },
        ],
        rows: [
          {
            path: "Home.md",
            cover: null,
            cells: [
              { type: "text", value: "Home" },
              { type: "text", value: "Draft" },
            ],
          },
          {
            path: "Other.md",
            cover: null,
            cells: [
              { type: "text", value: "Other" },
              { type: null, value: null },
            ],
          },
        ],
        grouping: null,
        cards: null,
        unsupported: [],
      },
    },
  });
  await page.evaluate(
    ([note, source]) => {
      const demo = (window as unknown as { __demo: { answer(c: string, v: unknown): void } })
        .__demo;
      // A function answer cannot be passed through the init script.
      demo.answer("read_text_file", (a: { path: string }) =>
        a.path.endsWith(".base") ? source : note,
      );
    },
    [text, base],
  );
  await openNote(page, "Home.md");

  const editor = page.locator(".cm-editor");
  const widgets = editor.locator(".cm-live-base");
  await expect(widgets).toHaveCount(2);
  await expect(editor.getByText("![[Notes.base]]")).toHaveCount(0);

  // Switching the view and sorting ask for the table again.
  const embed = widgets.nth(1);
  await takeCalls(page);
  await embed.getByText("By publication").click();
  await expect
    .poll(async () => (await takeCalls(page, "base_query")).at(-1)?.args)
    .toMatchObject({ source: base, view: 1 });
  await embed.getByRole("columnheader", { name: "Title" }).getByRole("button").click();
  await expect
    .poll(async () => (await takeCalls(page, "base_query")).at(-1)?.args)
    .toMatchObject({ view: 1, sort: { property: "title", direction: "ASC" } });
  await expect(widgets).toHaveCount(2);

  // With the editor focused, a click into a cell or a selection of its text keeps the base.
  await editor.getByText("The end.").click();
  const cell = widgets.first().getByRole("cell").last();
  const box = (await cell.boundingBox())!;
  // Beside the value, where no button takes the click; then a drag over the text of a cell.
  await page.mouse.click(box.x + box.width - 5, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width - 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 5, box.y + 5, { steps: 5 });
  await page.mouse.up();
  // CodeMirror reads a changed selection in a later task: two frames let it.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  await expect(widgets).toHaveCount(2);

  // A property of the open note is edited into the editor and saved.
  await takeCalls(page);
  await widgets.first().getByRole("button", { name: "Edit Title of Home: Draft" }).click();
  await widgets.first().getByRole("textbox", { name: "Title of Home" }).fill("Final");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await takeCalls(page, "replace_text_file")).at(-1)?.args)
    .toMatchObject({ expected: text, content: expect.stringContaining("title: Final") });

  // With the cursor inside, the block shows its source; leaving it draws the base again.
  await widgets
    .first()
    .locator("header")
    .click({ position: { x: 600, y: 5 } });
  await expect(widgets).toHaveCount(1);
  await expect(editor.getByText("name: Block")).toBeVisible();
  await editor.getByText("The end.").click();
  await expect(widgets).toHaveCount(2);

  // A click on a name opens the note.
  await widgets.first().getByRole("button", { name: "Other", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Other", selected: true })).toBeVisible();
});
