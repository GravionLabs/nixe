// The toolbar end and the properties toggle (#406, #418): layout by bounding boxes, the toggle by
// the button, the palette command and the settings page. The demo vault opens on `Home`, which has
// frontmatter (`src/demo/nixe/data.ts`).
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { openPalette, ready } from "./steps";

const toggle = (page: Page): Locator =>
  page.getByRole("button", { name: "Toggle properties in document" });
const folded = (page: Page): Locator => page.locator(".cm-content .properties-summary");

test.describe("layout of the toolbar end", () => {
  for (const width of [1800, 1280, 720]) {
    test(`nothing overlaps and the path is centred at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await ready(page);
      const modes = page.getByRole("group", { name: "View mode" });
      await expect(toggle(page)).toBeVisible();

      const items: Locator[] = [
        modes,
        toggle(page),
        page.getByRole("button", { name: "Toggle outline" }),
        page.getByRole("button", { name: "Toggle backlinks" }),
      ];
      const boxes: { x: number; y: number; width: number; height: number }[] = [];
      for (const item of items) {
        await expect(item).toBeVisible();
        const box = await item.boundingBox();
        expect(box).not.toBeNull();
        boxes.push(box!);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const apart =
            a.x + a.width <= b.x + 0.5 ||
            b.x + b.width <= a.x + 0.5 ||
            a.y + a.height <= b.y + 0.5 ||
            b.y + b.height <= a.y + 0.5;
          expect(apart, `element ${i} overlaps element ${j}: ${JSON.stringify([a, b])}`).toBe(true);
        }
      }

      // The path sits in the middle of the window.
      const path = await page.getByRole("navigation", { name: "Path of the note" }).boundingBox();
      expect(path).not.toBeNull();
      const middle = path!.x + path!.width / 2;
      expect(Math.abs(middle - width / 2), "path off centre").toBeLessThanOrEqual(2);

      // The view mode is a group of three icon buttons.
      await expect(modes.getByRole("button")).toHaveCount(3);
      await expect(modes.locator("select")).toHaveCount(0);
    });
  }
});

test.describe("properties toggle", () => {
  test.beforeEach(async ({ page }) => {
    await ready(page);
    await expect(page.locator(".cm-content")).toContainText("Welcome to the demo vault");
  });

  test("is off at the start: no block in the document, the panel shows them", async ({ page }) => {
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(folded(page)).toHaveCount(0);
    await expect(page.locator(".cm-content .properties-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "Toggle backlinks" }).click();
    await page.getByRole("tab", { name: "Properties" }).click();
    const panel = page.getByRole("tabpanel").getByRole("region", { name: "Properties" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("textbox", { name: "Name of property title" })).toBeVisible();
  });

  test("the button shows the folded line and hides it again", async ({ page }) => {
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(folded(page)).toBeVisible();
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(folded(page)).toHaveCount(0);
  });

  test("the palette command toggle-properties does the same", async ({ page }) => {
    for (const pressed of ["true", "false"]) {
      await openPalette(page);
      await page.getByRole("combobox").fill(">Toggle properties");
      await page.getByRole("button", { name: /^Toggle properties\b/ }).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", pressed);
      if (pressed === "true") await expect(folded(page)).toBeVisible();
      else await expect(folded(page)).toHaveCount(0);
    }
  });

  for (const width of [1800, 1280, 720]) {
    test(`the access token setting stays inside its column at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("searchbox", { name: "Search settings" }).fill("keychain");
      const token = page.locator(".token");
      // The demo build has no Git, so the setting may be absent there.
      if ((await token.count()) === 0) return;
      const column = await token.boundingBox();
      expect(column!.width).toBeLessThanOrEqual(320);
      for (const child of await token.locator("*").all()) {
        const box = await child.boundingBox();
        if (!box) continue;
        expect(box.x + box.width).toBeLessThanOrEqual(column!.x + column!.width + 1);
      }
    });
  }

  test("the settings page offers the three states and the toggle follows", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("searchbox", { name: "Search settings" }).fill("Properties in document");
    const select = page.getByRole("combobox", { name: "Properties in document" });
    await expect(select.getByRole("option")).toHaveText(["Visible", "Folded", "Hidden"]);
    for (const [value, pressed] of [
      ["folded", "true"],
      ["hidden", "false"],
      ["visible", "true"],
    ] as const) {
      await select.selectOption(value);
      // The toggle is disabled while the settings tab is in front.
      await page.getByRole("tab", { name: "Home" }).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", pressed);
      await page.getByRole("tab", { name: "Settings" }).click();
    }
  });
});
