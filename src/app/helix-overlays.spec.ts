import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ADR 0005: dialogs, menus and the toast come from helix (hx-dialog, hx-menu, hx-toast). A feature that builds
// its own backdrop, menu or toast fails here.
const root = resolve(__dirname);

function files(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, found);
    else if (/\.(html|css|scss|ts)$/.test(name) && !name.endsWith(".spec.ts")) found.push(path);
  }
  return found;
}

const sources = [...files(root), resolve(root, "../styles.scss")].map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));
const rel = (path: string) => path.slice(resolve(root, "..").length + 1);

// The viewer's zoom dialog pans and zooms an image or a diagram; hx-dialog has no such surface.
const ALLOWED_BACKDROP = new Set(["app/features/viewer/viewer.component.ts", "styles.scss"]);

describe("helix overlays", () => {
  it("builds no own backdrop", () => {
    const own = sources.filter(
      ({ path, text }) =>
        /(^|[\s."'-])(menu-)?backdrop\b/.test(text.replace(/diagram-dialog-backdrop/g, "")) &&
        !ALLOWED_BACKDROP.has(rel(path)),
    );
    expect(own.map(({ path }) => rel(path))).toEqual([]);
  });

  it("builds no own menu", () => {
    const own = sources.filter(({ path, text }) =>
      (/\.s?css$/.test(path) ? /\.menu\b/ : /role="menu"|role="menuitem|class="menu"/).test(text),
    );
    expect(own.map(({ path }) => rel(path))).toEqual([]);
  });

  it("builds no own toast", () => {
    const own = sources.filter(({ path, text }) =>
      (/\.s?css$/.test(path) ? /\.toast\b/ : /class="toast"/).test(text),
    );
    expect(own.map(({ path }) => rel(path))).toEqual([]);
  });

  it("has no hand-made dialog", () => {
    const own = sources.filter(
      ({ path, text }) => path.endsWith(".html") && /role="dialog"/.test(text),
    );
    expect(own.map(({ path }) => rel(path))).toEqual([]);
  });

  it.each(["switcher", "palette", "recent", "clone", "templates", "composer"])(
    "shows %s in an hx-dialog",
    (name) => {
      const html = readFileSync(resolve(root, `features/${name}/${name}.component.html`), "utf8");
      expect(html).toMatch(/^<hx-dialog /);
      expect(html.trimEnd()).toMatch(/<\/hx-dialog>$/);
    },
  );

  it("has one hx-toast in the root component", () => {
    const html = readFileSync(resolve(root, "app.component.html"), "utf8");
    expect(html.match(/<hx-toast/g)).toHaveLength(1);
  });

  it("opens the file tree menus with hx-menu", () => {
    const html = readFileSync(resolve(root, "features/sidebar/sidebar.component.html"), "utf8");
    expect(html.match(/<hx-menu /g)).toHaveLength(2);
  });
});
