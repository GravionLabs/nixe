// The steps shared by the e2e tests and `pnpm screenshots` (#402): they take a Playwright `Page` and
// import nothing from `@playwright/test`'s test runner, so a script can use them as well.
import type { Page } from "@playwright/test";

/** The path the demo vault opens with; see `src/demo/nixe/data.ts`. */
export const HOME_TITLE = "Home";

/** What a test or script reads of the page's `window.__demoCalls`. */
export interface Call {
  command: string;
  args?: Record<string, unknown>;
  order: number;
}

/** Opens the app (the demo, or the scripted fake with `fake`) and waits until the vault has loaded. */
export async function ready(
  page: Page,
  options: { fake?: boolean; script?: Record<string, unknown> } = {},
): Promise<void> {
  if (options.script !== undefined) {
    await page.addInitScript((script) => {
      (window as unknown as { __demoScript: unknown }).__demoScript = script;
    }, options.script);
  }
  await page.goto(options.fake === true ? "/?backend=fake" : "/");
  await page.getByRole("tree", { name: "Files" }).waitFor();
}

/** Opens a note from the file tree by its file name (`Home.md`). */
export async function openNote(page: Page, file: string): Promise<void> {
  await page
    .getByRole("treeitem")
    .filter({ hasText: file.replace(/\.md$/, "") })
    .first()
    .click();
}

const MOD = process.platform === "darwin" ? "Meta" : "Control";

/** Opens the command palette (`Mod+P`) and waits for its input. */
export async function openPalette(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+P`);
  await page.getByRole("combobox").waitFor();
}

/** Opens the vault search (`Mod+Shift+F`). */
export async function openSearch(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+F`);
  await page.getByRole("searchbox", { name: "Search the vault" }).waitFor();
}

/** Toggles the backlinks panel with its toolbar button. */
export async function toggleBacklinks(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Toggle backlinks" }).click();
}

/** The calls the backend recorded since the last read; reading clears them. */
export async function takeCalls(page: Page, command?: string): Promise<Call[]> {
  return page.evaluate((cmd) => {
    const w = window as unknown as { __demoCalls?: Call[] };
    const all = w.__demoCalls ?? [];
    w.__demoCalls = [];
    return cmd === undefined ? all : all.filter((c) => c.command === cmd);
  }, command);
}

/** The commands without an answer so far. */
export async function failures(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...((window as unknown as { __demoFailures?: string[] }).__demoFailures ?? []),
  ]);
}
