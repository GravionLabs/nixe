// The EPUB reader (#487): the table of contents, paged and scrolled reading, the keys and the
// sandbox of the book frame (ADR 0009), in the demo build with a real book.
import { readFileSync } from "node:fs";
import type { Frame, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { FAKE_VAULT } from "./fake-vault";
import { ready } from "./steps";

const BOOK = "/demo/Notes/Books/sample.epub";

async function openBook(page: Page, path: string): Promise<void> {
  await page.evaluate(
    (p) =>
      (
        window as unknown as { __nixeDev: { openEpub(p: string): Promise<void> } }
      ).__nixeDev.openEpub(p),
    path,
  );
}

/** The frame of the book (a `blob:` document) that shows `text`. */
async function bookFrame(page: Page, text: string): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(async () => {
      for (const frame of page.frames()) {
        if (!frame.url().startsWith("blob:")) continue;
        if (
          (
            await frame
              .locator("body")
              .textContent()
              .catch(() => "")
          )?.includes(text)
        ) {
          found = frame;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return found!;
}

test("the tab has the title of the book and the table of contents jumps to a chapter", async ({
  page,
}) => {
  await ready(page);
  await openBook(page, BOOK);
  await expect(page.getByRole("tab", { name: "Nixe Sample Book", selected: true })).toBeVisible();
  await bookFrame(page, "This is chapter 1");

  const toc = page.getByRole("navigation", { name: "Table of contents" });
  await expect(toc.getByRole("button")).toHaveText(["Chapter 1", "Chapter 2"]);
  await toc.getByRole("button", { name: "Chapter 2" }).click();
  await bookFrame(page, "This is chapter 2");
  await expect(toc.getByRole("button", { name: "Chapter 2" })).toHaveAttribute(
    "aria-current",
    "location",
  );
});

test("paged and scrolled reading switch, and the keys turn the page", async ({ page }) => {
  await ready(page);
  await openBook(page, BOOK);
  await bookFrame(page, "This is chapter 1");

  const paged = page.getByRole("button", { name: "Paged" });
  const scrolled = page.getByRole("button", { name: "Scrolled" });
  await expect(paged).toHaveAttribute("aria-pressed", "true");
  await scrolled.click();
  await expect(scrolled).toHaveAttribute("aria-pressed", "true");
  await expect(paged).toHaveAttribute("aria-pressed", "false");
  await paged.click();
  await expect(paged).toHaveAttribute("aria-pressed", "true");

  await page.getByLabel("Book", { exact: true }).focus();
  await page.keyboard.press("PageDown");
  await bookFrame(page, "This is chapter 2");
  await page.keyboard.press("PageUp");
  await bookFrame(page, "This is chapter 1");
});

test("a script in the book does not run", async ({ page }) => {
  const trap = [...readFileSync("fixtures/books/script.epub")];
  await ready(page, { fake: true, script: { ...FAKE_VAULT, read_epub: trap } });
  await openBook(page, "/fake/Notes/script.epub");
  const frame = await bookFrame(page, "This is chapter 1");

  const sandbox = await (await frame.frameElement()).getAttribute("sandbox");
  expect(sandbox).not.toBeNull();
  expect(sandbox!.split(/\s+/)).not.toContain("allow-scripts");

  // The inline script ran at load if it ever will; the handler needs a click.
  await frame.locator("h1").click();
  expect(
    await frame.evaluate(() => document.documentElement.getAttribute("data-script-ran")),
  ).toBeNull();
});
