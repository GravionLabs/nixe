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

for (const width of [1280, 720]) {
  test(`the palette lists the commands under group headings in a full-width input at ${width} px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await openPalette(page);
    const input = page.getByRole("combobox");
    await input.fill(">");
    const list = page.locator("#palette-list");
    await expect(list.locator("li.group", { hasText: "File" })).toBeVisible();
    await expect(list.locator("li.group", { hasText: "View" })).toBeVisible();
    const inputBox = await input.boundingBox();
    const listBox = await list.boundingBox();
    expect(inputBox!.width).toBeGreaterThan(listBox!.width - 24);
    // The headings are no options: the selection stays on a command row.
    const headings = await list.locator("li.group").allTextContents();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("ArrowDown");
      const selected = list.locator("li[role=option][aria-selected=true]");
      await expect(selected).toHaveCount(1);
      const text = (await selected.innerText()).trim();
      expect(headings.some((h) => text === h.trim())).toBe(false);
    }
  });
}

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

test.describe("links in the editor (#459)", () => {
  test.beforeEach(async ({ page }) => {
    await ready(page);
  });

  test("a click on a wikilink of a drawn line opens the note", async ({ page }) => {
    await openNote(page, "Home.md");
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("Welcome to the demo vault");
    await editor.getByText("Ideas", { exact: true }).click();
    await expect(editor).toContainText("A graph of the notes");
  });

  test("a click on the link of the line being edited edits it", async ({ page }) => {
    await openNote(page, "Ideas.md");
    const editor = page.locator(".cm-content");
    await editor.getByText("See ").click();
    await page.keyboard.press("End");
    await editor.getByText("Projects/Nixe").click();
    await expect(editor).toContainText("A graph of the notes");
    await expect(editor).toContainText("[[Projects/Nixe]]");
  });

  test("Ctrl+click on a URL and a Markdown link of the edited block calls the opener", async ({
    page,
  }) => {
    await openNote(page, "Ideas.md");
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\nhttps://example.com/a\n[Fly](https://example.com/b)\n\nend");
    const opened = () =>
      page.evaluate(() => (window as unknown as { __demoOpened?: string[] }).__demoOpened ?? []);
    await editor.getByText("https://example.com/a").click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(opened).toEqual(["https://example.com/a"]);
    await editor.getByText("Fly").click({ modifiers: ["ControlOrMeta"] });
    await expect.poll(opened).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  test("a plain click on a URL of a drawn line opens it in the system browser", async ({
    page,
  }) => {
    await openNote(page, "Ideas.md");
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\nhttps://example.com/a\n\nend");
    await editor.getByText("https://example.com/a").click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __demoOpened?: string[] }).__demoOpened ?? []),
      )
      .toEqual(["https://example.com/a"]);
  });
});
