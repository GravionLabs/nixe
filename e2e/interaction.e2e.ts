// Interaction tests on the scripted fake variant: the page answers only what `FAKE_VAULT` gives, and
// a test asserts an action by the call it made (#401, #405).
import { test, expect } from "./fixtures";
import { FAKE_NOTE, FAKE_TEXT, FAKE_VAULT } from "./fake-vault";
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
  expect(FAKE_TEXT).toContain("# Home");
});
