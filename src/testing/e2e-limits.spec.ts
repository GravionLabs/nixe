import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * #427: `pnpm e2e` hung in the CI because `ng serve` outlived the shell around it. A hang must be a
 * red job with a named test: Playwright ends the run (`globalTimeout`) and stops the server with
 * SIGTERM, and the job ends after 10 minutes at the latest.
 */
describe("limits of the e2e run", () => {
  const config = readFileSync("playwright.config.ts", "utf8");
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");

  it("the global timeout of Playwright is below the 10 minutes of the job", () => {
    expect(config).toMatch(/globalTimeout: process\.env\["CI"\] \? 8 \* 60_000/);
    expect(ci).toMatch(/e2e:[\s\S]*?timeout-minutes: 10/);
  });

  it("the web server is stopped with SIGTERM", () => {
    expect(config).toContain('gracefulShutdown: { signal: "SIGTERM"');
  });
});
