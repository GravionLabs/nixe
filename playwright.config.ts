import { defineConfig } from "@playwright/test";

// The UI tests (#401) run against the browser build of the app with the fake backend (#400):
// `pnpm start:demo` serves it on port 1422. Chromium only, in a light and a dark project.
const URL = "http://localhost:1422";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "test-results",
  use: {
    baseURL: URL,
    trace: "retain-on-failure",
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: "light", use: { browserName: "chromium", colorScheme: "light" } },
    { name: "dark", use: { browserName: "chromium", colorScheme: "dark" } },
  ],
  webServer: {
    command: "pnpm start:demo",
    url: URL,
    reuseExistingServer: !process.env["CI"],
    timeout: 180_000,
  },
});
