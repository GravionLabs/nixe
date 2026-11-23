// Back returns to the position of a link click (#480), on the scripted fake vault.
import { test, expect } from "./fixtures";
import { FAKE_VAULT } from "./fake-vault";
import { openNote, ready } from "./steps";

const FILLER = Array.from({ length: 60 }, (_, i) => `Row ${i + 1} of the weekly overview.\n`).join(
  "\n",
);
const TEXT = `# Plan\n\n${FILLER}\n[[#Unit A|A]]\n\n${FILLER}\n## Unit A\n\n${FILLER}\n`;

test("Back after a heading link returns to the row of the click", async ({ page }) => {
  await ready(page, { fake: true, script: { ...FAKE_VAULT, read_text_file: TEXT } });
  await openNote(page, "Home.md");
  await page.getByRole("button", { name: "Reading" }).click();
  const link = page.locator("a.wikilink", { hasText: "A" });
  await link.scrollIntoViewIfNeeded();
  await link.click();
  await expect(page.getByRole("heading", { name: "Unit A" })).toBeInViewport();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(link).toBeInViewport();
  await expect(page.getByRole("button", { name: "Forward", exact: true })).toBeEnabled();
});
