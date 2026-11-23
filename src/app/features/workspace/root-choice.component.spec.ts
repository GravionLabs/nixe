// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import type { RootChoice } from "../../core/workspace/workspaces.service";
import { WorkspacesService } from "../../core/workspace/workspaces.service";
import { RootChoiceComponent } from "./root-choice.component";

function render(pending: RootChoice | null, chooseRootForm = vi.fn().mockResolvedValue(undefined)) {
  const workspaces = {
    rootChoice: signal(pending),
    chooseRootForm,
    cancelRootChoice: vi.fn(),
  };
  document.body.replaceChildren();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: WorkspacesService, useValue: workspaces }],
  });
  TestBed.overrideComponent(RootChoiceComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/workspace/root-choice.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(RootChoiceComponent);
  fixture.detectChanges();
  return {
    fixture,
    workspaces, // hx-dialog renders its content in the overlay, outside the host element.
    el: document.body,
  };
}

const pending: RootChoice = {
  path: "/home/u/Documents/Books",
  choices: [
    { name: "Documents", template: "$Documents/Books", resolved: "/home/u/Documents/Books" },
    { name: "Home", template: "$Home/Documents/Books", resolved: "/home/u/Documents/Books" },
  ],
};

describe("RootChoiceComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("shows nothing without a pending choice", () => {
    expect(render(null).el.querySelector(".choice button")).toBeNull();
  });

  it("lists the absolute path first and each variable form with its resolved path", () => {
    const { el } = render(pending);
    const rows = [...el.querySelectorAll(".choice button")].map((b) =>
      [...b.querySelectorAll("span")].map((s) => s.textContent?.trim()),
    );
    expect(rows).toEqual([
      ["Absolute path", "/home/u/Documents/Books"],
      ["$Documents/Books", "/home/u/Documents/Books"],
      ["$Home/Documents/Books", "/home/u/Documents/Books"],
    ]);
  });

  it("hands the chosen form to the service", () => {
    const { el, workspaces } = render(pending);
    const buttons = el.querySelectorAll(".choice button");
    buttons[1].click();
    expect(workspaces.chooseRootForm).toHaveBeenCalledWith("$Documents/Books");
    buttons[0].click();
    expect(workspaces.chooseRootForm).toHaveBeenLastCalledWith(null);
  });

  it("reports a failure to add", async () => {
    const { fixture, el } = render(pending, vi.fn().mockRejectedValue("boom"));
    const failed = vi.fn();
    fixture.componentInstance.failed.subscribe(failed);
    el.querySelector(".choice button")!.click();
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("boom"));
  });
});
