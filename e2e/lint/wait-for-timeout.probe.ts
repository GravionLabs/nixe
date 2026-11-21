// A deliberate violation of `nixe-e2e/no-wait-for-timeout`; `src/testing/lint-probe.spec.ts` lints it and
// expects the report. `pnpm lint` leaves it out.
import type { Page } from "@playwright/test";

export async function sleep(page: Page): Promise<void> {
  await page.waitForTimeout(10);
}
