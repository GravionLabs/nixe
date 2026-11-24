import { test as base, expect } from "@playwright/test";
import { failures } from "./steps";

// Every test fails on a script error, a `console.error` and a command the backend could not answer.
// Two messages that are no fault of the app: Chromium reports a script it blocked in the sandboxed
// frame of an EPUB (the probes of Playwright run one, ADR 0009), and a ResizeObserver that finishes
// its work in the next frame (foliate-js lays out the book that way).
const HARMLESS = [
  /Blocked script execution in .* the 'allow-scripts' permission is not set/,
  /ResizeObserver loop completed with undelivered notifications/,
];

export const test = base.extend<{ guard: void }>({
  guard: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => {
        if (!HARMLESS.some((re) => re.test(error.message)))
          problems.push(`pageerror: ${error.message}`);
      });
      page.on("console", (msg) => {
        if (msg.type() === "error" && !HARMLESS.some((re) => re.test(msg.text())))
          problems.push(`console.error: ${msg.text()}`);
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
