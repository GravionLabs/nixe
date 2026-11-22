// Interaction tests on the scripted fake variant: the page answers only what `FAKE_VAULT` gives, and
// a test asserts an action by the call it made (#401, #405).
import { test, expect } from "./fixtures";
import { FAKE_NOTE, FAKE_VAULT } from "./fake-vault";
import { openNote, openPalette, ready, takeCalls } from "./steps";

test.beforeEach(async ({ page }) => {
  await ready(page, { fake: true, script: FAKE_VAULT });
});

test("the palette takes the focus, Escape closes it and the focus returns to the opener", async ({
  page,
}) => {
  const opener = page.getByRole("treeitem", { name: "Home", exact: true });
  await opener.focus();
  await openPalette(page);
  await expect(page.getByRole("combobox")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox")).toBeHidden();
  await expect(opener).toBeFocused();
});

test("the palette lists the commands under group headings in a full-width input", async ({
  page,
}) => {
  await openPalette(page);
  const input = page.getByRole("combobox");
  await input.fill(">");
  const list = page.locator("#palette-list");
  await expect(list.locator("li.group").first()).toBeVisible();
  await expect(list.locator("li.group", { hasText: "File" })).toBeVisible();
  await expect(list.locator("li.group", { hasText: "View" })).toBeVisible();
  const inputBox = await input.boundingBox();
  const listBox = await list.boundingBox();
  expect(inputBox!.width).toBeGreaterThan(listBox!.width - 24);
  // The headings are no options; the arrow keys land on commands.
  await page.keyboard.press("ArrowDown");
  await expect(list.locator("li.group[aria-selected]")).toHaveCount(0);
  await expect(list.locator("li[role=option][aria-selected=true]")).toHaveCount(1);
});

test("editing a note saves it with write_text_file", async ({ page }) => {
  await openNote(page, "Home.md");
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("A note of the fake vault.");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("Added by the test.");
  await expect
    .poll(async () => (await takeCalls(page, "write_text_file")).at(-1)?.args)
    .toEqual({ path: FAKE_NOTE, content: expect.stringContaining("Added by the test.") });
});
