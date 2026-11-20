import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The component itself cannot be mounted in a spec: it reads its host through a signal query,
// which the JIT setup of the specs does not support. The bar is checked on its template.
const html = readFileSync(resolve(__dirname, "editor.component.html"), "utf8");
const bar = html.slice(html.indexOf('<div class="bar"'), html.indexOf("</div>") + 6);

describe("external change bar (template)", () => {
  it("is an alert", () => {
    expect(bar).toContain('role="alert"');
  });

  it("has Reload, Keep mine and Compare as buttons in reading order", () => {
    const labels = [...bar.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1].trim());
    expect(labels).toEqual(["Reload", "Keep mine", "Compare"]);
    expect(bar).not.toMatch(/tabindex/i);
  });

  it("says what each choice does", () => {
    const text = bar.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(text).toContain("Reload discards your unsaved edits.");
    expect(text).toContain("Keep mine replaces the version on disk with your next save.");
  });

  it("opens the compare dialog with the same two choices", () => {
    expect(bar).toContain('(click)="compare()"');
    expect(html).toContain("<app-external-compare");
    // An empty editor text is falsy: the dialog must test for null, not truthiness.
    expect(html).toContain("@if (comparing() !== null)");
    expect(html).toContain('(reload)="chooseReload()"');
    expect(html).toContain('(keep)="chooseKeep()"');
  });
});
