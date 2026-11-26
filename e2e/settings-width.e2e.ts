// The settings page keeps a readable width on a wide window (#544): the search field and the rows
// stop at the maximum, the scrollbar stays at the right edge of the page.
import { test, expect } from "./fixtures";
import { ready } from "./steps";

const MAX = 760;

for (const width of [1920, 1280, 720]) {
  test(`the settings rows are at most ${MAX} px wide at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    await page.keyboard.press("ControlOrMeta+,");
    const search = page.getByRole("searchbox", { name: "Search settings" });
    await expect(search).toBeVisible();
    const field = await search.boundingBox();
    expect(field!.width).toBeLessThanOrEqual(MAX + 1);
    const rows = page.getByRole("region", { name: "Settings" }).locator(".row");
    expect(await rows.count()).toBeGreaterThan(0);
    for (const row of await rows.all()) {
      const box = await row.boundingBox();
      if (!box) continue;
      expect(box.width).toBeLessThanOrEqual(MAX + 1);
      expect(box.x).toBeCloseTo(field!.x, 0);
    }
    // The scrolling area itself still reaches the right edge of the page, not of the column.
    const region = page.getByRole("region", { name: "Settings" });
    const dialog = await region.boundingBox();
    const content = await region.locator(".content").boundingBox();
    expect(content!.x + content!.width).toBeGreaterThanOrEqual(dialog!.x + dialog!.width - 1);
    // No horizontal scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  });
}

test("the selects and fields of the settings rows have the same box", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+,");
  const region = page.getByRole("region", { name: "Settings" });
  await expect(region).toBeVisible();
  const sections = region.getByRole("navigation").getByRole("button");
  const boxes: { width: number; height: number; right: number }[] = [];
  for (const section of await sections.all()) {
    await section.click();
    // The controls are collected only once the clicked section is the one shown.
    const title = (await section.innerText()).trim();
    await expect(region.getByRole("heading", { level: 2, name: title })).toBeVisible();
    const controls = region.locator(
      '.control > select, .control > input[type="text"], .control > input[type="number"]',
    );
    for (const control of await controls.all()) {
      const box = await control.boundingBox();
      boxes.push({ width: box!.width, height: box!.height, right: box!.x + box!.width });
    }
  }
  expect(boxes.length).toBeGreaterThan(1);
  for (const box of boxes) {
    expect(box.width).toBeCloseTo(boxes[0].width, 0);
    expect(box.height).toBeCloseTo(boxes[0].height, 0);
    expect(box.right).toBeCloseTo(boxes[0].right, 0);
  }
});
