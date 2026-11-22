// Smoke tests on the demo variant: whole views against the seeded vault (#401). They also prove the
// demo build of #400 starts.
import { test, expect } from "./fixtures";
import { failures, openNote, openPalette, openSearch, ready, toggleBacklinks } from "./steps";

test("the app starts without a command that has no answer", async ({ page }) => {
  await ready(page);
  expect(await failures(page)).toEqual([]);
});

test("the vault opens with the home note", async ({ page }) => {
  await ready(page);
  await expect(page.getByRole("tab", { name: "Home", selected: true })).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("Welcome to the demo vault");
});

test("a note opens from the tree", async ({ page }) => {
  await ready(page);
  await openNote(page, "Ideas.md");
  await expect(page.getByRole("tab", { name: "Ideas", selected: true })).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("A graph of the notes");
});

test("the backlinks panel shows the links of the note", async ({ page }) => {
  await ready(page);
  await toggleBacklinks(page);
  await expect(page.getByRole("region", { name: "Backlinks" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Outgoing links" })).toBeVisible();
});

test("the search opens", async ({ page }) => {
  await ready(page);
  await openSearch(page);
  await expect(page.getByRole("searchbox", { name: "Search the vault" })).toBeFocused();
});

test("the command palette opens", async ({ page }) => {
  await ready(page);
  await openPalette(page);
  await expect(page.getByRole("combobox")).toBeFocused();
});

test("a click opens a note in the preview tab, a double click keeps it in a tab of its own", async ({
  page,
}) => {
  await ready(page);
  const tabs = page.getByRole("tab");
  const tree = (name: string) => page.getByRole("treeitem", { name, exact: false }).first();
  // The home note is the preview tab: the next click replaces it.
  await openNote(page, "Ideas.md");
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute("aria-label", "Ideas");
  await expect(page.locator(".hx-tab-bar-tab-preview")).toHaveCount(1);
  // The double click pins the note: the next click opens a preview tab beside it.
  await tree("Ideas").dblclick();
  await expect(page.locator(".hx-tab-bar-tab-preview")).toHaveCount(0);
  await expect(tabs).toHaveCount(1);
  await tree("Projects").click();
  await openNote(page, "Nixe.md");
  await expect(tabs).toHaveCount(2);
  await expect(page.locator(".hx-tab-bar-tab-preview")).toHaveCount(1);
  await openNote(page, "Helix.md");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute("aria-label", "Helix");
});
