// A `.base` file (#630): the tree lists it, a click opens the table tab, a click on a name the note.
import { test, expect } from "./fixtures";
import { FAKE_NOTE, FAKE_VAULT } from "./fake-vault";
import { ready } from "./steps";

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
