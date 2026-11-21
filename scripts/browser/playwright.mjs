// Shared Playwright setup (#402): the browser install, the demo server, the light and the dark theme.
// `scripts/screenshots.mjs` and the e2e tests (#401) use it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

export const THEMES = ["light", "dark"];

/** The dev servers of `angular.json`. */
export const TARGETS = {
  /** The app with the demo backend instead of Tauri (`serve` configuration `demo`, #400). */
  demo: { name: "nixe:serve:demo", port: 1422 },
};

async function reachable(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

/** Installs Chromium when this Playwright version has none (a no-op when it is there). */
export async function ensureBrowser() {
  if (existsSync(chromium.executablePath())) return;
  console.error("Installing Chromium for Playwright…");
  await new Promise((done, fail) => {
    const p = spawn("pnpm", ["exec", "playwright", "install", "chromium"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    p.on("exit", (code) => (code === 0 ? done() : fail(new Error(`playwright install: ${code}`))));
  });
}

/** Ends `pnpm` and the `ng` it started (the process group; `taskkill` on Windows). */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else process.kill(-child.pid, "SIGTERM");
}

/** Starts `ng run <target>` unless it already answers; resolves with the URL and a stop function. */
export async function ensureServer(target) {
  const url = `http://localhost:${target.port}/`;
  if (await reachable(url)) return { url, stop: async () => {} };
  const child = spawn("pnpm", ["exec", "ng", "run", target.name, "--port", String(target.port)], {
    stdio: ["ignore", "ignore", "inherit"],
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
  });
  let exited = false;
  child.on("exit", () => (exited = true));
  for (let i = 0; i < 600; i++) {
    if (await reachable(url)) return { url, stop: async () => killTree(child) };
    if (exited) throw new Error(`ng run ${target.name} exited`);
    await new Promise((r) => setTimeout(r, 200));
  }
  killTree(child);
  throw new Error(`ng run ${target.name} did not answer on ${url}`);
}

/**
 * Runs `fn({ open, url })` with a headless Chromium and the server of `target`. `open(path, theme,
 * viewport, options)` returns a page in that theme (`prefers-color-scheme`). `options.time` fixes
 * `Date.now()` (the timers stay real), `options.storage` is put into `localStorage` before the page
 * runs and `options.reducedMotion` turns animations off.
 */
export async function withBrowser(target, fn) {
  await ensureBrowser();
  const server = await ensureServer(target);
  const browser = await chromium.launch();
  const open = async (path, theme, viewport = { width: 1280, height: 800 }, options = {}) => {
    const context = await browser.newContext({
      colorScheme: theme,
      viewport,
      reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
    });
    const page = await context.newPage();
    if (options.time !== undefined) await page.clock.setFixedTime(options.time);
    if (options.storage) {
      await page.addInitScript((entries) => {
        for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
      }, options.storage);
    }
    page.on("pageerror", (err) => console.error(`page error: ${err.message}`));
    // A dev server that was just started may drop the first connection while it optimizes.
    for (let attempt = 1; ; attempt++) {
      try {
        await page.goto(new URL(path, server.url).href);
        return page;
      } catch (err) {
        if (attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  };
  try {
    return await fn({ open, url: server.url });
  } finally {
    await browser.close();
    await server.stop();
  }
}
