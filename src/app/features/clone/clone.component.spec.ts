// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { CloneService } from "../../core/git/clone.service";
import { GitService } from "../../core/git/git.service";
import { CloneComponent } from "./clone.component";

function render(
  prompt: { reason: "required" | "failed"; host: string } | null = null,
  cloning = false,
  gh = { available: false, signingIn: false, code: null as string | null },
  state = { error: "", canStart: !cloning },
) {
  const clone = {
    visible: signal(true),
    url: signal("https://github.com/a/b"),
    parent: signal(""),
    cloning: signal(cloning),
    error: signal(state.error),
    percent: signal<number | null>(cloning ? 40 : null),
    canStart: signal(state.canStart),
    start: vi.fn(),
    close: vi.fn(),
    chooseFolder: vi.fn().mockResolvedValue(undefined),
  };
  const git = {
    tokenPrompt: signal(prompt),
    saveToken: vi.fn().mockResolvedValue(undefined),
    ghAvailable: signal(gh.available),
    ghSigningIn: signal(gh.signingIn),
    ghCode: signal(gh.code),
    ghError: signal(""),
    ghNotice: signal(""),
    signInWithGh: vi.fn().mockResolvedValue(undefined),
    cancelGhSignIn: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: CloneService, useValue: clone },
      { provide: GitService, useValue: git },
    ],
  });
  TestBed.overrideComponent(CloneComponent, { set: { styleUrl: undefined } });
  const fixture = TestBed.createComponent(CloneComponent);
  fixture.detectChanges();
  // hx-dialog renders its content in the overlay, outside the host element.
  return { clone, git, el: document.body, fixture };
}

describe("CloneComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  const buttons = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>("button")];
  const button = (el: HTMLElement, label: string) =>
    buttons(el).find((b) => b.textContent?.trim() === label)!;
  const field = (el: HTMLElement, label: string) => {
    const found = [...el.querySelectorAll("label")].find((l) => l.textContent?.trim() === label)!;
    return el.querySelector<HTMLInputElement>(`#${found.htmlFor}`)!;
  };

  it("focuses the URL field on open", async () => {
    // jsdom has no layout, so the focus trap would take every element for invisible.
    const rects = vi
      .spyOn(Element.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList);
    const { el } = render();
    const url = field(el, "Repository URL");
    expect(url.type).toBe("url");
    await vi.waitFor(() => expect(document.activeElement).toBe(url));
    rects.mockRestore();
  });

  it("submits with the default button of the form, which Enter presses", () => {
    const { clone, el } = render();
    const submit = button(el, "Clone");
    expect(submit.type).toBe("submit");
    expect(submit.form).toBe(field(el, "Repository URL").form);
    // The first submit button of the form is the one Enter presses.
    const form = submit.form!;
    expect(buttons(el).find((b) => b.form === form && b.type === "submit")).toBe(submit);
    submit.click();
    expect(clone.start).toHaveBeenCalledOnce();
  });

  it("closes on Escape and on the mask", async () => {
    for (const close of [
      (el: HTMLElement) =>
        el
          .querySelector("[role=dialog]")!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }),
          ),
      (el: HTMLElement) => el.querySelector<HTMLElement>(".hx-dialog-backdrop")!.click(),
    ]) {
      const { clone, el, fixture } = render();
      close(el);
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(clone.close).toHaveBeenCalled();
      });
    }
  });

  it("has Close as text button before the one primary button in the footer", () => {
    const { clone, el } = render();
    const footer = [...el.querySelectorAll<HTMLElement>(".hx-dialog-footer button")];
    expect(footer.map((b) => b.textContent?.trim())).toEqual(["Close", "Clone"]);
    expect(footer[0].classList).toContain("hx-button-text");
    const primary = buttons(el).filter(
      (b) =>
        b.hasAttribute("hx-button") &&
        !b.matches(".hx-button-text, .hx-button-outlined, .hx-button-link"),
    );
    expect(primary).toEqual([footer[1]]);
    footer[0].click();
    expect(clone.close).toHaveBeenCalled();
  });

  it("disables Clone until the form is complete", () => {
    const { el } = render(null, false, undefined, { error: "", canStart: false });
    expect(button(el, "Clone").disabled).toBe(true);
  });

  it("shows the progress, a loading Clone button and a cancel button while cloning", () => {
    const { clone, el } = render(null, true);
    expect(el.textContent).toContain("Cloning… 40%");
    const bar = el.querySelector("[role=progressbar]")!;
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    const submit = button(el, "Clone");
    expect(submit.getAttribute("aria-busy")).toBe("true");
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(clone.start).not.toHaveBeenCalled();
    expect(button(el, "Cancel clone")).toBeDefined();
  });

  it("is not loading when no clone runs", () => {
    const { el } = render();
    expect(button(el, "Clone").getAttribute("aria-busy")).not.toBe("true");
  });

  it("shows an error as hx-message with the next action inside", () => {
    const { clone, el } = render(null, false, undefined, {
      error: "Clone failed: no network",
      canStart: true,
    });
    const message = el.querySelector("hx-message")!;
    expect(message.classList).toContain("hx-message-error");
    expect(message.getAttribute("role")).toBe("alert");
    expect(message.textContent).toContain("Clone failed: no network");
    button(message as HTMLElement, "Try again").click();
    expect(clone.start).toHaveBeenCalledOnce();
  });

  it("offers no retry while the form is incomplete", () => {
    const { el } = render(null, false, undefined, { error: "no dialog", canStart: false });
    expect(el.querySelector("hx-message")?.textContent).toContain("no dialog");
    expect(button(el, "Try again")).toBeUndefined();
  });

  it("chooses the target folder", () => {
    const { clone, el, fixture } = render();
    const target = field(el, "Target folder");
    expect(target.readOnly).toBe(true);
    expect(target.placeholder).toBe("No target folder chosen");
    clone.parent.set("/home/me/vaults");
    fixture.detectChanges();
    expect(target.value).toBe("/home/me/vaults");
    button(el, "Choose folder…").click();
    expect(clone.chooseFolder).toHaveBeenCalled();
  });

  it("reuses the token prompt of the Git service", () => {
    const { git, el } = render({ reason: "failed", host: "github.com" });
    expect(el.querySelector("hx-message.hx-message-error")?.textContent).toContain("rejected");
    const input = el.querySelector("input[type=password]") as HTMLInputElement;
    input.value = "tok";
    button(el.querySelector<HTMLElement>("hx-message")!, "Save token").click();
    expect(git.saveToken).toHaveBeenCalledWith("tok");
  });

  it("has no token field without a prompt", () => {
    const { el } = render();
    expect(el.querySelector("input[type=password]")).toBeNull();
  });

  const prompt = { reason: "required", host: "ghe.example.com" } as const;
  const signInButton = (el: HTMLElement) =>
    [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Sign in with GitHub"));

  it("hides the gh sign-in without gh", () => {
    const { el } = render(prompt);
    expect(signInButton(el)).toBeUndefined();
    expect(el.querySelector("input[type=password]")).not.toBeNull();
  });

  it("signs in through gh for the host that asked", () => {
    const { git, el } = render(prompt, false, { available: true, signingIn: false, code: null });
    signInButton(el)!.click();
    expect(git.signInWithGh).toHaveBeenCalledWith("ghe.example.com");
  });

  it("shows the notice of a finished gh sign-in", () => {
    const { git, el, fixture } = render(prompt, false, {
      available: true,
      signingIn: false,
      code: null,
    });
    git.ghNotice.set("Signed in to ghe.example.com with the GitHub CLI.");
    fixture.detectChanges();
    expect(el.querySelector("[role=status]")?.textContent).toContain("Signed in to");
  });

  it("shows the one-time code and can cancel", () => {
    const { git, el } = render(prompt, false, {
      available: true,
      signingIn: true,
      code: "ABCD-1234",
    });
    expect(el.querySelector(".gh")?.textContent).toContain("ABCD-1234");
    expect(signInButton(el)!.getAttribute("aria-busy")).toBe("true");
    (el.querySelector(".gh button") as HTMLElement).click();
    expect(git.cancelGhSignIn).toHaveBeenCalled();
  });
});
