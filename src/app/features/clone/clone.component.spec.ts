// @vitest-environment jsdom
import "@angular/compiler";
import { type Provider, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { invoke } from "@tauri-apps/api/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { CloneService } from "../../core/git/clone.service";
import { GitService } from "../../core/git/git.service";
import { SettingsService } from "../../core/settings/settings.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
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
  const settings = { gitEnterpriseHost: signal("") };
  const fixture = create([
    { provide: CloneService, useValue: clone },
    { provide: GitService, useValue: git },
    { provide: SettingsService, useValue: settings },
  ]);
  // hx-dialog renders its content in the overlay, outside the host element.
  return { clone, git, settings, el: document.body, fixture };
}

/** The dialog on the real `CloneService`, so a submit reaches the backend commands. */
function renderWithService(openFolder = vi.fn().mockResolvedValue(undefined)) {
  const git = {
    tokenPrompt: signal(null),
    runRemote: <T>(run: () => Promise<T>) => run(),
    cancelTokenPrompt: vi.fn(),
  };
  const fixture = create([
    { provide: GitService, useValue: git },
    { provide: SettingsService, useValue: { gitEnterpriseHost: signal("") } },
    { provide: WorkspaceService, useValue: { openFolder } },
  ]);
  const clone = TestBed.inject(CloneService);
  clone.open();
  fixture.detectChanges();
  return { clone, openFolder, el: document.body, fixture };
}

function create(providers: Provider[]) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers });
  TestBed.overrideComponent(CloneComponent, { set: { styleUrl: undefined } });
  const fixture = TestBed.createComponent(CloneComponent);
  fixture.detectChanges();
  return fixture;
}

describe("CloneComponent", () => {
  beforeAll(() => {
    TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
  });

  const buttons = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>("button")];
  const button = (el: HTMLElement, label: string) =>
    buttons(el).find((b) => b.textContent?.trim() === label)!;
  const label = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll("label")].find((l) => l.textContent?.replace("*", "").trim() === name)!;
  const field = (el: HTMLElement, name: string) =>
    el.querySelector<HTMLInputElement>(`#${label(el, name).htmlFor}`)!;
  const urlError = (el: HTMLElement) =>
    el.querySelector(".hx-field-error-shown")?.textContent?.trim();
  const folderError = (el: HTMLElement) => el.querySelector("#clone-folder-error");
  const described = (el: HTMLElement, input: HTMLElement) =>
    (input.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => el.querySelector(`#${id}`)?.textContent?.trim());
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event("input"));
  };

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    document.body.innerHTML = "";
  });

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

  const escape = (el: HTMLElement) =>
    el
      .querySelector("[role=dialog]")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
  const closeButton = (el: HTMLElement) => el.querySelector(".hx-dialog-close");
  const backdrop = (el: HTMLElement) => el.querySelector<HTMLElement>(".hx-dialog-backdrop")!;

  it("closes the idle dialog on Escape", async () => {
    const { clone, el, fixture } = render();
    expect(closeButton(el)).not.toBeNull();
    escape(el);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(clone.close).toHaveBeenCalled();
    });
  });

  it("stays open on a click on the mask", async () => {
    const { clone, el, fixture } = render();
    backdrop(el).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(clone.close).not.toHaveBeenCalled();
    expect(el.querySelector("[role=dialog]")).not.toBeNull();
  });

  it("has Cancel clone as the only way out while cloning", async () => {
    const { clone, el, fixture } = render(null, true);
    escape(el);
    backdrop(el).click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(clone.close).not.toHaveBeenCalled();
    expect(el.querySelector("[role=dialog]")).not.toBeNull();
    expect(closeButton(el)).toBeNull();
    button(el, "Cancel clone").click();
    expect(clone.close).toHaveBeenCalledOnce();
  });

  it("closes on Escape again once the clone has ended", async () => {
    const { clone, el, fixture } = render(null, true);
    clone.cloning.set(false);
    fixture.detectChanges();
    expect(closeButton(el)).not.toBeNull();
    escape(el);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(clone.close).toHaveBeenCalled();
    });
  });

  it("has the size class md", () => {
    const { el } = render();
    expect(el.querySelector(".hx-dialog-size-md")).not.toBeNull();
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

  it("shows both errors on a submit of the empty form and calls no backend command", async () => {
    const { el, fixture } = renderWithService();
    expect(urlError(el)).toBeUndefined();
    expect(folderError(el)).toBeNull();
    const submit = button(el, "Clone");
    expect(submit.disabled).toBe(false);

    submit.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const url = field(el, "Repository URL");
    expect(urlError(el)).toBe("Enter an HTTPS URL of github.com");
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(described(el, url)).toContain("Enter an HTTPS URL of github.com");
    const target = field(el, "Target folder");
    expect(folderError(el)?.classList).toContain("hx-message-error");
    expect(folderError(el)?.textContent?.trim()).toBe("Choose a target folder");
    expect(target.getAttribute("aria-invalid")).toBe("true");
    expect(target.getAttribute("aria-describedby")).toBe("clone-folder-error");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses an SSH URL with the error on the field", async () => {
    const { clone, el, fixture } = renderWithService();
    clone.parent.set("/home/me/vaults");
    type(field(el, "Repository URL"), "git@github.com:owner/notes.git");
    button(el, "Clone").click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(urlError(el)).toBe("Enter an HTTPS URL of github.com");
    expect(folderError(el)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("starts the clone of a valid form", async () => {
    vi.mocked(invoke).mockResolvedValue("/home/me/vaults/notes");
    const { clone, openFolder, el, fixture } = renderWithService();
    type(field(el, "Repository URL"), "https://github.com/owner/notes.git");
    clone.parent.set("/home/me/vaults");
    fixture.detectChanges();
    button(el, "Clone").click();
    await vi.waitFor(() => expect(openFolder).toHaveBeenCalledWith("/home/me/vaults/notes"));
    expect(invoke).toHaveBeenCalledWith("git_clone_vault", {
      url: "https://github.com/owner/notes.git",
      parent: "/home/me/vaults",
    });
  });

  it("clears the errors once the form is complete", () => {
    const { clone, el, fixture } = render(null, false, undefined, { error: "", canStart: false });
    clone.url.set("");
    button(el, "Clone").click();
    fixture.detectChanges();
    expect(urlError(el)).toBeDefined();
    expect(folderError(el)).not.toBeNull();

    type(field(el, "Repository URL"), "https://github.com/owner/notes.git");
    clone.parent.set("/home/me/vaults");
    fixture.detectChanges();
    expect(clone.url()).toBe("https://github.com/owner/notes.git");
    expect(urlError(el)).toBeUndefined();
    expect(folderError(el)).toBeNull();
    const target = field(el, "Target folder");
    expect(target.hasAttribute("aria-invalid")).toBe(false);
    expect(target.hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows the URL error when the field is left invalid", () => {
    const { el, fixture } = render();
    const url = field(el, "Repository URL");
    type(url, "https://gitlab.com/a/b.git");
    fixture.detectChanges();
    expect(urlError(el)).toBeUndefined();
    url.dispatchEvent(new FocusEvent("blur"));
    fixture.detectChanges();
    expect(urlError(el)).toBe("Enter an HTTPS URL of github.com");
    expect(folderError(el)).toBeNull();
  });

  it("names the configured enterprise host in the hint and the error", () => {
    const { settings, el, fixture } = render();
    settings.gitEnterpriseHost.set("ghe.example.com");
    const url = field(el, "Repository URL");
    type(url, "https://other.example.com/a/b.git");
    url.dispatchEvent(new FocusEvent("blur"));
    fixture.detectChanges();
    expect(urlError(el)).toBe("Enter an HTTPS URL of github.com or ghe.example.com");
    expect(el.querySelector(".hx-field-hint")?.textContent).toContain("ghe.example.com");
    type(url, "https://ghe.example.com/a/b.git");
    fixture.detectChanges();
    expect(urlError(el)).toBeUndefined();
  });

  it("marks both fields as required and gives the URL format as hint, not as placeholder", () => {
    const { el } = render();
    for (const name of ["Repository URL", "Target folder"]) {
      expect(label(el, name).querySelector(".hx-field-required"), name).not.toBeNull();
      expect(field(el, name).getAttribute("aria-required"), name).toBe("true");
    }
    const url = field(el, "Repository URL");
    expect(url.hasAttribute("placeholder")).toBe(false);
    expect(described(el, url)[0]).toContain("https://<host>/<owner>/<repository>");
  });

  it("disables the URL field while cloning", () => {
    const { el } = render(null, true);
    expect(field(el, "Repository URL").disabled).toBe(true);
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
