import { test as base, expect } from "@playwright/test";
import { failures } from "./steps";

// Every test fails on a script error, a `console.error` and a command the backend could not answer.
export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      page.on("console", (msg) => {
        if (msg.type() === "error") problems.push(`console.error: ${msg.text()}`);
      });
      await use();
      const missing = await failures(page).catch(() => []);
      for (const command of missing) problems.push(`__demoFailures: ${command}`);
      expect(problems, "errors of the page").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
