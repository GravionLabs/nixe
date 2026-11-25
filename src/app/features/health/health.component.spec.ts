// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { DeadLink, HealthReport } from "../../core/file/backend";
import { TabsService } from "../../core/tabs/tabs.service";
import type { HealthState } from "../../core/index/health.service";
import { HealthService } from "../../core/index/health.service";
import { SettingsService } from "../../core/settings/settings.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { HealthComponent } from "./health.component";

const report: HealthReport = {
  brokenLinks: [{ source: "a.md", line: 4, target: "Gone", kind: "link", context: "see [[Gone]]" }],
  orphans: [{ path: "work/lonely.md", title: "lonely" }],
  duplicates: [{ name: "Twin", paths: ["x/Twin.md", "y/Twin.md"] }],
  unusedAttachments: ["assets/old.png"],
};

const dead: DeadLink[] = [
  {
    source: "Links/Gone.md",
    url: "https://gone.example/",
    reason: "404",
    snapshot: "http://web.archive.org/web/2020/https://gone.example/",
    checked: "2026-11-24T10:00:00+00:00",
  },
  {
    source: "Links/NoCopy.md",
    url: "https://nocopy.example/",
    reason: "dns",
    snapshot: null,
    checked: "2026-11-24T10:00:00+00:00",
  },
];

function render(
  state: HealthState,
  value: HealthReport | null,
  deadLinks: DeadLink[] | null = null,
) {
  const open = vi.fn().mockResolvedValue(undefined);
  const setExcluded = vi.fn();
  const refresh = vi.fn();
  const checkLinks = vi.fn().mockResolvedValue(undefined);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: HealthService,
        useValue: {
          state: signal(state),
          report: signal(value),
          key: signal("k"),
          refresh,
          setExcluded,
          deadLinks: signal(deadLinks),
          checkingLinks: signal(false),
          linkCheckFailed: signal(false),
          checkLinks,
        },
      },
      { provide: SettingsService, useValue: { healthExclude: signal(["templates"]) } },
      { provide: TabsService, useValue: { openInNewTab: open } },
      { provide: WorkspaceService, useValue: { vaultRoot: signal("/vault") } },
    ],
  });
  TestBed.overrideComponent(HealthComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/health/health.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(HealthComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, open, setExcluded, refresh, checkLinks };
}

describe("HealthComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("lists the four categories with their counts", () => {
    const { el, refresh } = render("ready", report);
    expect(refresh).toHaveBeenCalled();
    for (const label of [
      "Broken links",
      "Orphan notes",
      "Duplicate basenames",
      "Unused attachments",
    ]) {
      expect(el.querySelector(`section[aria-label="${label}"] .count`)?.textContent).toBe("1");
    }
    expect(el.textContent).toContain("see [[Gone]]");
    expect(el.textContent).toContain("assets/old.png");
  });

  it("opens the note of each entry, a broken link at its line", () => {
    const { el, open } = render("ready", report);
    const buttons = [
      ...el.querySelectorAll<HTMLButtonElement>("section:not([aria-label='Dead links']) button"),
    ];
    buttons.forEach((b) => b.click());
    expect(open.mock.calls).toEqual([
      ["/vault/a.md", { line: 4 }],
      ["/vault/work/lonely.md", { line: null }],
      ["/vault/x/Twin.md", { line: null }],
      ["/vault/y/Twin.md", { line: null }],
      ["/vault/assets/old.png", { line: null }],
    ]);
  });

  it("shows the excluded folders, forwards edits", () => {
    const { el, setExcluded } = render("ready", report);
    const input = el.querySelector("input")!;
    expect(input.value).toBe("templates");
    input.value = "templates, archive";
    input.dispatchEvent(new Event("change"));
    expect(setExcluded).toHaveBeenCalledWith("templates, archive");
  });

  it("says so while indexing and when the index failed", () => {
    expect(render("loading", null).el.textContent).toContain("Indexing the vault");
    expect(render("error", null).el.textContent).toContain("not available");
  });

  it("checks the links only on request, the button runs the check", () => {
    const { el, checkLinks } = render("ready", report);
    expect(checkLinks).not.toHaveBeenCalled();
    expect(el.querySelector("section[aria-label='Dead links'] .count")).toBeNull();
    el.querySelector<HTMLButtonElement>(".check-links")!.click();
    expect(checkLinks).toHaveBeenCalledWith("/vault", false);
  });

  it("lists the dead links with the snapshot next to them", () => {
    const { el, open, checkLinks } = render("ready", report, dead);
    const section = el.querySelector("section[aria-label='Dead links']")!;
    expect(section.querySelector(".count")?.textContent).toBe("2");
    expect(section.textContent).toContain("https://gone.example/ (404)");
    const anchors = section.querySelectorAll<HTMLAnchorElement>("a.snapshot");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].href).toBe("http://web.archive.org/web/2020/https://gone.example/");
    section.querySelector<HTMLButtonElement>(".dead button")!.click();
    expect(open).toHaveBeenCalledWith("/vault/Links/Gone.md", { line: null });
    section.querySelector<HTMLButtonElement>(".recheck-links")!.click();
    expect(checkLinks).toHaveBeenCalledWith("/vault", true);
  });
});
