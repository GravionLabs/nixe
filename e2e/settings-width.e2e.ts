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
