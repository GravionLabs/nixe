// The settings page keeps a readable width on a wide window (#544): the rows stop at the maximum, the scrollbar stays at the right edge of the page.
import { test, expect } from "./fixtures";
import { ready } from "./steps";

const MAX = 760;

for (const width of [1920, 1280, 720]) {
  test(`the settings rows are at most ${MAX} px wide at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    await page.keyboard.press("ControlOrMeta+,");
    const search = page.getByRole("searchbox", { name: "Search settings" });
    // Opening the page focuses the search field.
    await expect(search).toBeFocused();
    const region = page.getByRole("region", { name: "Settings" });
    // The search field uses the width of the left column, above the section list (#722).
    const field = await search.boundingBox();
    const nav = await region.getByRole("navigation").boundingBox();
    expect(field!.x).toBeCloseTo(nav!.x, 0);
    expect(field!.width).toBeCloseTo(nav!.width, 0);
    expect(field!.y + field!.height).toBeLessThanOrEqual(nav!.y);
    const section = await region.locator(".group").boundingBox();
    expect(section!.width).toBeLessThanOrEqual(MAX + 1);
    expect(section!.x).toBeGreaterThan(field!.x + field!.width);
    const rows = region.locator(".row");
    expect(await rows.count()).toBeGreaterThan(0);
    for (const row of await rows.all()) {
      const box = await row.boundingBox();
      if (!box) continue;
      expect(box.x).toBeGreaterThanOrEqual(section!.x);
      expect(box.x + box.width).toBeLessThanOrEqual(section!.x + section!.width + 1);
    }
    // The scrolling area itself still reaches the right edge of the page, not of the column.
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
    await expect(region.getByRole("group", { name: title })).toBeVisible();
    const controls = region.locator(
      '.control > hx-select, .control > input[type="text"], .control > input[type="number"]',
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

test("the fields stay inside their section in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await ready(page);
  await page.keyboard.press("ControlOrMeta+,");
  const region = page.getByRole("region", { name: "Settings" });
  await region.getByRole("navigation").getByRole("button", { name: "Appearance" }).click();
  await expect(region.getByRole("group", { name: "Appearance" })).toBeVisible();
  const section = await region.locator(".group").boundingBox();
  const controls = region.locator(".control > *");
  expect(await controls.count()).toBeGreaterThan(0);
  for (const control of await controls.all()) {
    const box = await control.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(section!.x + section!.width + 1);
  }
});

test("a recording shortcut has the focus and Escape ends it", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+,");
  const region = page.getByRole("region", { name: "Settings" });
  await region.getByRole("navigation").getByRole("button", { name: "Shortcuts" }).click();
  const chip = region.locator("button.key").first();
  await chip.click();
  const recorder = region.locator("button.key.recording");
  await expect(recorder).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(recorder).toHaveCount(0);
});

test("the locations list starts at the height of its label", async ({ page }) => {
  await ready(page);
  await page.keyboard.press("ControlOrMeta+,");
  const region = page.getByRole("region", { name: "Settings" });
  await region.getByRole("navigation").getByRole("button", { name: "Locations" }).click();
  const label = await region.getByText("Location variables of this device").boundingBox();
  const list = region.getByRole("list", { name: "Location variables" });
  const first = await list.getByRole("listitem").first().boundingBox();
  expect(Math.abs(first!.y - label!.y)).toBeLessThanOrEqual(2);
  // The demo vault has a variable: its text, not only its row, starts there.
  const text = list.locator(".loc-name, .empty").first();
  if ((await text.evaluate((el) => el.tagName)) === "SPAN") {
    expect(Math.abs((await text.boundingBox())!.y - label!.y)).toBeLessThanOrEqual(2);
  }
});

for (const width of [1280, 720]) {
  test(`the access token lines up with the other controls at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    await page.keyboard.press("ControlOrMeta+,");
    const region = page.getByRole("region", { name: "Settings" });
    await region.getByRole("navigation").getByRole("button", { name: "Sync" }).click();
    const token = await region.locator(".token").boundingBox();
    const input = await region.locator('.control > input[type="text"]').first().boundingBox();
    const section = await region.locator(".group").boundingBox();
    expect(token!.x + token!.width).toBeLessThanOrEqual(section!.x + section!.width + 1);
    for (const part of await region.locator(".token *").all()) {
      const box = await part.boundingBox();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(token!.x + token!.width + 1);
    }
    // Side by side with its label (not stacked): the same edges as a text field.
    if (width === 1280) {
      expect(token!.x).toBeCloseTo(input!.x, 0);
      expect(token!.x + token!.width).toBeCloseTo(input!.x + input!.width, 0);
    }
  });
}
