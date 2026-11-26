// The Links view (#516) on the link notes of the fixture vault: the unread inbox, cards and table,
// mark as read, and the two ways to open a link.
import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { test, expect } from "./fixtures";
import { FAKE_VAULT } from "./fake-vault";
import { ready, takeCalls } from "./steps";

const COLUMNS = ["file.name", "title", "site", "tags", "saved", "status", "url"];

const fixture = (name: string) => readFileSync(`fixtures/vault/Links/${name}.md`, "utf8");

/** The row `base_query` answers for a link note of the fixture vault. */
function row(name: string) {
  const values = parse(/^---\n([\s\S]*?)\n---/.exec(fixture(name))![1]!) as Record<string, unknown>;
  return {
    path: `Links/${name}.md`,
    cover: null,
    cells: COLUMNS.map((id) => {
      const value = id === "file.name" ? name : (values[id] ?? null);
      return { type: Array.isArray(value) ? "list" : "text", value };
    }),
  };
}

test("the unread inbox, the table, mark as read and opening a link", async ({ page }) => {
  await ready(page, {
    fake: true,
    script: {
      ...FAKE_VAULT,
      base_query: {
        view: "Links",
        columns: COLUMNS.map((id) => ({ id, label: id })),
        rows: [row("Unread Page"), row("Example Article")],
        grouping: null,
        unsupported: [],
      },
      read_text_file: fixture("Unread Page"),
    },
  });
  await page.locator('hx-activity-bar [data-id="links"]').click();
  await expect(page.getByRole("tab", { name: "Links", selected: true })).toBeVisible();

  // Unread is the default: the read article is not in it.
  const cards = page.getByRole("region", { name: "Links" });
  await expect(cards.getByRole("article")).toHaveCount(1);
  await expect(cards).toContainText("Unread Page");
  await expect(cards).toContainText("later");

  await page.getByRole("group", { name: "Inbox" }).getByText("All").click();
  await expect(cards.getByRole("article")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Tag" }).click();
  await page.getByRole("option", { name: "reading", exact: true }).click();
  await expect(cards.getByRole("article")).toHaveCount(1);
  await expect(cards).toContainText("example.com");
  await page.getByRole("combobox", { name: "Tag" }).click();
  await page.getByRole("option", { name: "All", exact: true }).click();

  await page.getByRole("group", { name: "Layout" }).getByText("Table").click();
  const table = page.getByRole("table", { name: "Links" });
  await expect(table.getByRole("columnheader")).toHaveText([
    "Title",
    "Site",
    "Tags",
    "Saved",
    "Status",
  ]);

  await takeCalls(page);
  await table.getByRole("button", { name: "Mark Unread Page read" }).click();
  await expect(table.getByRole("button", { name: "Mark Unread Page unread" })).toBeVisible();
  await expect
    .poll(async () => (await takeCalls(page, "replace_text_file"))[0]?.args?.["content"])
    .toBe(fixture("Unread Page").replace("status: unread", "status: read"));

  await table.getByRole("button", { name: "Unread Page", exact: true }).click({
    modifiers: ["ControlOrMeta"],
  });
  // The demo build records what the app wants to open (`src/demo/tauri/opener.ts`).
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __demoOpened?: string[] }).__demoOpened ?? []),
    )
    .toEqual(["https://example.org/unread"]);

  await table.getByRole("button", { name: "Unread Page", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Unread Page", selected: true })).toBeVisible();
});
