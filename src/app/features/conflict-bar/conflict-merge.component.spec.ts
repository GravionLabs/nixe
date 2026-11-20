// @vitest-environment jsdom
import "@angular/compiler";
import { readFileSync } from "node:fs";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { ConflictService } from "../../core/git/conflict.service";
import { ConflictMergeComponent } from "./conflict-merge.component";

function render(merging: { mine: string; theirs: string } | null) {
  const service = {
    merging: signal(merging),
    cancelMerge: vi.fn(),
    saveMerge: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [{ provide: ConflictService, useValue: service }] });
  TestBed.overrideComponent(ConflictMergeComponent, {
    set: {
      templateUrl: undefined,
      styleUrl: undefined,
      template: readFileSync("src/app/features/conflict-bar/conflict-merge.component.html", "utf8"),
    },
  });
  const fixture = TestBed.createComponent(ConflictMergeComponent);
  const errors: string[] = [];
  fixture.componentInstance.failed.subscribe((e) => errors.push(e));
  fixture.detectChanges();
  // hx-dialog renders its content in the overlay, outside the host element.
  const el = document.body;
  const button = (label: string) =>
    Array.from(el.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;
  const result = () => el.querySelector<HTMLTextAreaElement>("textarea")!;
  const click = (label: string, n = 0) => {
    Array.from(el.querySelectorAll("button"))
      .filter((b) => b.textContent?.trim() === label)
      [n].click();
    fixture.detectChanges();
  };
  return { el, service, errors, fixture, button, result, click };
}

const texts = { mine: "one\nmine\nthree\nfour-a\n", theirs: "one\ntheirs\nthree\nfour-b\n" };

describe("ConflictMergeComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  it("shows nothing while no merge is open", () => {
    expect(render(null).el.querySelector(".merge")).toBeNull();
  });

  it("marks the changed hunks and starts with this note's text", () => {
    const { el, result } = render(texts);
    expect(el.querySelectorAll(".hunk")).toHaveLength(2);
    expect(el.querySelector(".hunk pre.del")?.textContent).toBe("mine");
    expect(el.querySelector(".hunk pre.add")?.textContent).toBe("theirs");
    expect(result().value).toBe(texts.mine);
  });

  it("takes each hunk from this, the other or both", () => {
    const { result, click } = render(texts);
    click("Take the other", 0);
    click("Take both", 1);
    expect(result().value).toBe("one\ntheirs\nthree\nfour-a\nfour-b\n");
    click("Take this", 1);
    expect(result().value).toBe("one\ntheirs\nthree\nfour-a\n");
  });

  it("saves the edited result", async () => {
    const { result, click, service, fixture } = render(texts);
    result().value = "my own text";
    result().dispatchEvent(new Event("input"));
    fixture.detectChanges();
    click("Save");
    await fixture.whenStable();
    expect(service.saveMerge).toHaveBeenCalledWith("my own text");
  });

  it("cancel writes nothing", () => {
    const { click, service } = render(texts);
    click("Cancel");
    expect(service.cancelMerge).toHaveBeenCalled();
    expect(service.saveMerge).not.toHaveBeenCalled();
  });

  it("reports a failed save", async () => {
    const { click, service, errors, fixture } = render(texts);
    service.saveMerge.mockRejectedValue("boom");
    click("Save");
    await fixture.whenStable();
    expect(errors).toEqual(["boom"]);
  });
});
