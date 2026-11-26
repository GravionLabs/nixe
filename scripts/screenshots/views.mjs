// The views of the screenshots (#402): what the app does before each picture. `scripts/screenshots.mjs`
// runs them in light and dark against the demo backend (`src/demo/nixe/`); the e2e tests (#401) use
// the step helpers too. A step uses what a user sees (a button name, a text), so a renamed label
// fails the run instead of shooting the wrong screen.

/** The instant the clock is fixed to; the demo vault counts from it (`src/demo/nixe/data.ts`). */
export const TIME = "2026-11-21T09:00:00Z";
/** The window of every picture. */
export const VIEWPORT = { width: 1280, height: 800 };

/** Waits for the app to show the file tree of the demo vault. */
export async function ready(page) {
  await page.getByRole("treeitem").first().waitFor();
}

/** Opens the note `name` from the file tree (a double click pins the tab). */
export async function openNote(page, name) {
  await page.getByRole("treeitem", { name }).first().dblclick();
}

/** Unfolds the folder `name` of the file tree. */
export async function openFolder(page, name) {
  await page.getByRole("treeitem", { name }).first().click();
}

/** Opens a view of the activity bar by its id ("files", "search", …). */
export async function openView(page, id) {
  await page.locator(`hx-activity-bar [data-id="${id}"]`).click();
}

/** Types `query` into the vault search and waits for the first result. */
export async function searchFor(page, query) {
  await openView(page, "search");
  await page.getByLabel("Search the vault").fill(query);
  await page.getByRole("list", { name: "Results" }).waitFor();
}

/** Shows the backlinks panel of the open note. */
export async function showBacklinks(page) {
  await page.getByRole("button", { name: "Toggle backlinks" }).click();
  await page.getByRole("region", { name: "Backlinks" }).waitFor();
}

/** Each view: `name` (the file is `<name>-<theme>.png`) and `run(page)`. */
export const VIEWS = [
  {
    name: "editor",
    run: async (page) => {
      await ready(page);
      await openFolder(page, "Projects");
      await openNote(page, "Nixe");
      await page.locator(".cm-content").waitFor();
    },
  },
  {
    name: "backlinks",
    run: async (page) => {
      await ready(page);
      await openFolder(page, "Projects");
      await openNote(page, "Helix");
      await page.locator(".cm-content").waitFor();
      await showBacklinks(page);
      await page.getByRole("button", { name: /Home/ }).first().waitFor();
    },
  },
  {
    name: "settings-locations",
    run: async (page) => {
      await ready(page);
      await page.keyboard.press("ControlOrMeta+,");
      await page.getByRole("region", { name: "Settings" }).waitFor();
      await page.getByRole("button", { name: "Locations", exact: true }).click();
      await page.getByRole("list", { name: "Location variables" }).waitFor();
    },
  },
  {
    name: "epub-reader",
    run: async (page) => {
      await ready(page);
      // The dev hook of the demo build opens the book until a link does (#488).
      await page.evaluate(() => window.__nixeDev.openEpub("/demo/Notes/Books/sample.epub"));
      await page.getByRole("navigation", { name: "Table of contents" }).waitFor();
      await page.waitForFunction(() => document.querySelector("foliate-view") !== null);
      // The book follows the theme: wait until its frame is styled before the picture is taken.
      await page.waitForFunction(() =>
        [...document.querySelectorAll("foliate-view")].some(
          (v) =>
            v.renderer?.getContents?.()[0]?.doc &&
            getComputedStyle(v.renderer.getContents()[0].doc.documentElement).colorScheme !==
              "normal",
        ),
      );
    },
  },
  {
    name: "clone",
    run: async (page) => {
      await ready(page);
      await page.keyboard.press("ControlOrMeta+P");
      await page.getByRole("combobox").fill(">Clone vault");
      await page.getByRole("option", { name: /Clone vault/ }).click();
      await page.getByRole("dialog", { name: "Clone vault" }).waitFor();
    },
  },
  {
    name: "search",
    run: async (page) => {
      await ready(page);
      await searchFor(page, "Nixe");
    },
  },
];
