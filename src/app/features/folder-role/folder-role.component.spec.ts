// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { FolderRolesService } from "../../core/workspace/folder-roles.service";
import { FolderRoleComponent } from "./folder-role.component";

function render(current: { role: string; description: string | null } | null = null) {
  const service = {
    dialog: signal({ path: "/v/Work", rel: "Work", current }),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    closeDialog: vi.fn(),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: FolderRolesService, useValue: service }],
  });
  TestBed.overrideComponent(FolderRoleComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/folder-role/folder-role.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(FolderRoleComponent);
  fixture.detectChanges();
  // hx-dialog renders its content in the overlay, outside the host element.
  return { service, fixture, el: document.body };
}

const type = (el: HTMLElement, selector: string, value: string) => {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event("input"));
};

describe("FolderRoleComponent", () => {
  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  it("offers the standard roles and saves the typed role with its description", async () => {
    const { service, fixture, el } = render();
    const options = [...el.querySelectorAll("#folder-role-names option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toContain("inbox");
    expect(options).toContain("exams");
    type(el, "input[list]", "inbox");
    type(el, "input[placeholder^='What']", "loose notes");
    fixture.detectChanges();
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(service.set).toHaveBeenCalledWith("Work", "inbox", "loose notes"),
    );
    expect(service.closeDialog).toHaveBeenCalled();
    expect(el.querySelector("[role=dialog]")?.textContent).toContain("Work");
  });

  it("asks for a description of an own role and shows the error of a refusal", async () => {
    const { service, fixture, el } = render();
    expect(el.textContent).not.toContain("required for an own role");
    type(el, "input[list]", "vault-inbox");
    fixture.detectChanges();
    expect(el.textContent).toContain("required for an own role");
    service.set.mockRejectedValue(new Error("An own role needs a description."));
    el.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector("[role=alert]")?.textContent).toContain("needs a description");
    });
    expect(service.closeDialog).not.toHaveBeenCalled();
  });

  it("starts with the current role and removes it", async () => {
    const { service, el } = render({ role: "exams", description: "all exams" });
    expect(el.querySelector<HTMLInputElement>("input[list]")!.value).toBe("exams");
    const remove = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Remove folder role"),
    )!;
    remove.click();
    await vi.waitFor(() => expect(service.remove).toHaveBeenCalledWith("Work"));
    expect(service.closeDialog).toHaveBeenCalled();
  });

  it("has no removal for a folder without a role", () => {
    const { el } = render();
    expect(el.textContent).not.toContain("Remove folder role");
  });
});
