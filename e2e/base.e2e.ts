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
