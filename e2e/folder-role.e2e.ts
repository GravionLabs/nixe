// Set and remove a folder role in the demo vault (#446): the context menu of a folder, the dialog,
// the mark in the tree and the entry on the settings page.
import { test, expect } from "./fixtures";
import { ready } from "./steps";

test("a folder gets a role from its context menu and shows the mark", async ({ page }) => {
  await ready(page);
  const folder = page.locator('[data-path="/demo/Notes/Projects"]');
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set folder role…" }).click();
  await page.getByRole("combobox", { name: "Role" }).fill("projects");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(folder.locator("svg.role")).toHaveAccessibleName("Folder role: projects");

  await folder.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Remove folder role" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Remove folder role" }).click();
  await expect(folder.locator("svg.role")).toHaveCount(0);
});

test("an own role needs a description", async ({ page }) => {
  await ready(page);
  const folder = page.locator('[data-path="/demo/Notes/Projects"]');
  await folder.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set folder role…" }).click();
  await page.getByRole("combobox", { name: "Role" }).fill("vault-inbox");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("needs a description");
  await page.getByRole("textbox", { name: "Description" }).fill("loose notes");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(folder.locator("svg.role")).toHaveAccessibleName(
    "Folder role: vault-inbox: loose notes",
  );
});
