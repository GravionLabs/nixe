// The pictures of the docs and the site (#402): `pnpm screenshots [name...] [--out <dir>]` writes
// `<name>-<theme>.png` for the light and the dark theme (default folder `site/public/screenshots`).
// The app runs in headless Chromium with the demo backend instead of Tauri, a fixed clock, no
// animation and a fixed window, so two runs give the same images. A command the demo backend does
// not answer fails the run with its name; a failed view leaves a picture in `tmp/shots/`.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { THEMES, TARGETS, withBrowser } from "./browser/playwright.mjs";
import { TIME, VIEWPORT, VIEWS } from "./screenshots/views.mjs";

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const out = resolve(outFlag >= 0 ? args[outFlag + 1] : "site/public/screenshots");
const wanted = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");

async function main() {
  const unknown = wanted.filter((n) => !VIEWS.some((v) => v.name === n));
  if (unknown.length) {
    console.error(`unknown view: ${unknown.join(", ")} (${VIEWS.map((v) => v.name).join(", ")})`);
    return 2;
  }
  const views = wanted.length ? VIEWS.filter((v) => wanted.includes(v.name)) : VIEWS;
  mkdirSync(out, { recursive: true });
  const failures = [];
  const code = await withBrowser(TARGETS.demo, async ({ open }) => {
    for (const view of views) {
      for (const theme of THEMES) {
        const page = await open("/", theme, VIEWPORT, {
          time: Date.parse(TIME),
          reducedMotion: true,
        });
        page.setDefaultTimeout(10_000);
        try {
          await view.run(page);
          // Let the signals settle: the fonts, the first paint of the panels.
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(400);
          const missing = await page.evaluate(() => window.__demoFailures ?? []);
          if (missing.length) {
            // The catch below records the failure and leaves the picture in tmp/shots.
            throw new Error(`no demo answer for ${[...new Set(missing)].join(", ")}`);
          }
          const file = join(out, `${view.name}-${theme}.png`);
          await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
          console.log(file);
        } catch (err) {
          failures.push(
            `${view.name} (${theme}): ${err.message.split("\n").slice(0, 3).join(" ")}`,
          );
          // What the page showed when the view failed, for a look (git-ignored `tmp/`).
          mkdirSync("tmp/shots", { recursive: true });
          await page
            .screenshot({ path: `tmp/shots/failed-${view.name}-${theme}.png` })
            .catch(() => {});
        } finally {
          await page
            .context()
            .close()
            .catch(() => {});
        }
      }
    }
    return 0;
  });
  if (failures.length) {
    console.error(`\n${failures.length} failed:\n- ${failures.join("\n- ")}`);
    return 1;
  }
  return code;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
