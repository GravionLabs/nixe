// The import of `.obsidian/` into `.nixe/` when a vault opens (#441), on the scripted fake variant:
// the backend answers what the Rust core reports for a vault with `.obsidian/` and no `.nixe/`.
import { test, expect } from "./fixtures";
import { FAKE_VAULT } from "./fake-vault";
import { ready, takeCalls } from "./steps";

test("a vault with .obsidian and without .nixe shows what was imported", async ({ page }) => {
  await ready(page, {
    fake: true,
    script: {
      ...FAKE_VAULT,
      import_obsidian_settings: {
        written: [".nixe/config.json", ".nixe/bookmarks.json"],
        sources: [".obsidian/app.json", ".obsidian/bookmarks.json"],
        warnings: [],
      },
    },
  });
  await expect(page.getByText("Imported the settings from .obsidian/app.json")).toBeVisible();
  await expect(page.getByText("next commit")).toBeVisible();
  expect((await takeCalls(page, "import_obsidian_settings")).length).toBe(1);
});

test("a failed import is a warning and the vault opens", async ({ page }) => {
  await ready(page, {
    fake: true,
    script: {
      ...FAKE_VAULT,
      import_obsidian_settings: {
        written: [],
        sources: [],
        warnings: [".nixe/config.json was not written: read-only"],
      },
    },
  });
  await expect(page.getByText("Warning: import of .obsidian/ incomplete")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Files" })).toBeVisible();
});
