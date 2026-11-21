// @vitest-environment jsdom
import "@angular/compiler";
import { signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const xterm = vi.hoisted(() => {
  const instances: unknown[] = [];
  return { instances };
});

vi.mock("@xterm/xterm", () => {
  class Terminal {
    rows = 24;
    cols = 80;
    written: (Uint8Array | string)[] = [];
    disposed = false;
    focused = 0;
    dataHandler: (d: string) => void = () => undefined;
    resizeHandler: (s: { rows: number; cols: number }) => void = () => undefined;
    constructor() {
      xterm.instances.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {
      this.focused++;
    }
    write(d: Uint8Array | string) {
      this.written.push(d);
    }
    reset() {
      this.written = [];
    }
    dispose() {
      this.disposed = true;
    }
    onData(h: (d: string) => void) {
      this.dataHandler = h;
    }
    onResize(h: (s: { rows: number; cols: number }) => void) {
      this.resizeHandler = h;
    }
  }
  return { Terminal };
});
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@gravionlabs/helix-desktop", () => ({
  getHxPlatform: () => "desktop",
  getHxPlatformKind: (p: string) => p,
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

import { SettingsService } from "../../core/settings/settings.service";
import { TerminalBackend } from "../../core/terminal/terminal-backend";
import { CommandRegistry } from "../../core/commands/command-registry";
import { TerminalService } from "../../core/terminal/terminal.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";
import { TerminalPanelComponent } from "./terminal-panel.component";

interface FakeTerm {
  rows: number;
  cols: number;
  written: (Uint8Array | string)[];
  disposed: boolean;
  focused: number;
  dataHandler: (d: string) => void;
  resizeHandler: (s: { rows: number; cols: number }) => void;
}

class FakeBackend {
  nextId = 1;
  opened: [number, number][] = [];
  written: [number, string][] = [];
  resized: [number, number, number][] = [];
  closed: number[] = [];
  output = new Map<number, (b: Uint8Array) => void>();
  exit = new Map<number, () => void>();
  presets: (string | null)[] = [];
  checks: string[] = [];
  missing: string | null = null;
  async checkPreset(id: string) {
    this.checks.push(id);
    if (this.missing) throw this.missing;
  }
  async open(rows: number, cols: number, preset: string | null = null) {
    this.opened.push([rows, cols]);
    this.presets.push(preset);
    return this.nextId++;
  }
  attached: number[] = [];
  async attach(id: number) {
    this.attached.push(id);
  }
  async write(id: number, data: string) {
    this.written.push([id, data]);
  }
  async resize(id: number, rows: number, cols: number) {
    this.resized.push([id, rows, cols]);
  }
  async close(id: number) {
    this.closed.push(id);
  }
  async onOutput(id: number, h: (b: Uint8Array) => void) {
    this.output.set(id, h);
    return () => this.output.delete(id);
  }
  async onExit(id: number, h: () => void) {
    this.exit.set(id, h);
    return () => this.exit.delete(id);
  }
}

describe("TerminalPanelComponent", () => {
  const terminalEnabled = signal(true);
  const terminalVisible = signal(true);
  const terminalHeight = signal(240);
  const vaultRoot = signal<string | null>("/v");
  let backend: FakeBackend;

  beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));

  beforeEach(() => {
    xterm.instances.length = 0;
    terminalEnabled.set(true);
    terminalVisible.set(true);
    terminalHeight.set(240);
    vaultRoot.set("/v");
    backend = new FakeBackend();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: TerminalBackend, useValue: backend },
        {
          provide: SettingsService,
          useValue: {
            terminalEnabled,
            terminalVisible,
            terminalHeight,
            terminalConfirmed: signal(true),
          },
        },
        { provide: WorkspaceService, useValue: { vaultRoot } },
      ],
    });
  });

  function override(): void {
    TestBed.overrideComponent(TerminalPanelComponent, {
      set: { styleUrl: undefined, styles: [] },
    });
  }

  async function render() {
    override();
    const fixture = TestBed.createComponent(TerminalPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await vi.waitFor(() => expect(backend.attached).toEqual([1]));
    return { fixture, term: xterm.instances[0] as FakeTerm };
  }

  it("opens a session with the size of the terminal and shows its output", async () => {
    const { term } = await render();
    expect(backend.opened).toEqual([[24, 80]]);
    expect(backend.attached).toEqual([1]); // after the listeners, so no output is lost
    backend.output.get(1)!(new TextEncoder().encode("hi"));
    expect(term.written).toEqual([new TextEncoder().encode("hi")]);
    expect(term.focused).toBeGreaterThan(0);
  });

  it("starts the shell without a preset, the CLI with one, from the buttons", async () => {
    const { fixture } = await render();
    expect(backend.presets).toEqual([null]);
    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll("button.tab-preset"),
    );
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Claude", "Copilot"]);
    buttons[1].click();
    await vi.waitFor(() => expect(backend.presets).toEqual([null, "copilot"]));
    expect(backend.checks).toEqual(["copilot"]);
  });

  it("opens no tab for a missing CLI", async () => {
    const { fixture } = await render();
    backend.missing = "Claude Code is not installed.";
    fixture.nativeElement.querySelectorAll("button.tab-preset")[0].click();
    await vi.waitFor(() =>
      expect(TestBed.inject(TerminalService).notice()).toBe("Claude Code is not installed."),
    );
    expect(TestBed.inject(TerminalService).tabs()).toHaveLength(1);
    expect(backend.opened).toHaveLength(1);
  });

  it("sends the input to the session and its size changes", async () => {
    const { term } = await render();
    term.dataHandler("ls\r");
    term.resizeHandler({ rows: 10, cols: 50 });
    expect(backend.written).toEqual([[1, "ls\r"]]);
    expect(backend.resized).toEqual([[1, 10, 50]]);
  });

  it("keeps the session while the panel is hidden and shown again", async () => {
    const { fixture } = await render();
    terminalVisible.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.classList.contains("open")).toBe(false);
    terminalVisible.set(true);
    fixture.detectChanges();
    expect(backend.opened).toHaveLength(1);
    expect(backend.closed).toEqual([]);
  });

  it("starts no session while the panel was never shown", async () => {
    terminalVisible.set(false);
    override();
    const fixture = TestBed.createComponent(TerminalPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(backend.opened).toEqual([]);
    terminalVisible.set(true);
    fixture.detectChanges();
    await vi.waitFor(() => expect(backend.opened).toHaveLength(1));
  });

  it("closes the session when the component goes away", async () => {
    const { fixture, term } = await render();
    fixture.destroy();
    expect(backend.closed).toEqual([1]);
    expect(term.disposed).toBe(true);
  });

  it("ends the session of a vault and starts a new one in the next vault", async () => {
    const { fixture } = await render();
    vaultRoot.set("/w");
    fixture.detectChanges();
    await vi.waitFor(() => expect(backend.opened).toHaveLength(2));
    expect(backend.closed).toEqual([1]);
  });

  it("starts a new shell on a key after the process ended", async () => {
    const { term } = await render();
    backend.exit.get(1)!();
    expect(String(term.written.at(-1))).toContain("process ended");
    term.dataHandler("x");
    await vi.waitFor(() => expect(backend.opened).toHaveLength(2));
  });

  it("shows an error when the session cannot start", async () => {
    backend.open = async () => {
      throw "the terminal is turned off in the settings";
    };
    override();
    const fixture = TestBed.createComponent(TerminalPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain("turned off");
    });
  });

  it("opens a second session in a new tab and keeps each tab's output", async () => {
    const { fixture, term } = await render();
    const service = TestBed.inject(TerminalService);
    TestBed.inject(CommandRegistry).execute("new-terminal-tab");
    fixture.detectChanges();
    await vi.waitFor(() => expect(backend.attached).toEqual([1, 2]));
    const second = xterm.instances[1] as FakeTerm;
    backend.output.get(1)!(new TextEncoder().encode("one"));
    backend.output.get(2)!(new TextEncoder().encode("two"));
    expect(term.written).toEqual([new TextEncoder().encode("one")]);
    expect(second.written).toEqual([new TextEncoder().encode("two")]);
    second.dataHandler("a");
    service.selectTab(1);
    fixture.detectChanges();
    term.dataHandler("b");
    expect(backend.written).toEqual([
      [2, "a"],
      [1, "b"],
    ]);
    const screens = fixture.nativeElement.querySelectorAll(".screens > div");
    expect([screens[0].style.display, screens[1].style.display]).toEqual(["", "none"]);
    expect(backend.closed).toEqual([]);
  });

  it("ends the session of a closed tab only, and the panel stays open and empty", async () => {
    const { fixture, term } = await render();
    const service = TestBed.inject(TerminalService);
    service.newTab();
    fixture.detectChanges();
    await vi.waitFor(() => expect(backend.attached).toEqual([1, 2]));
    TestBed.inject(CommandRegistry).execute("close-terminal-tab");
    fixture.detectChanges();
    expect(backend.closed).toEqual([2]);
    expect((xterm.instances[1] as FakeTerm).disposed).toBe(true);
    expect(service.activeKey()).toBe(1);
    service.closeTab();
    fixture.detectChanges();
    expect(backend.closed).toEqual([2, 1]);
    expect(term.disposed).toBe(true);
    expect(service.tabs()).toEqual([]);
    expect(terminalVisible()).toBe(true);
    expect(backend.opened).toHaveLength(2);
    const button = fixture.nativeElement.querySelector(".empty button") as HTMLButtonElement;
    expect(button.textContent).toContain("New terminal");
    button.click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(backend.opened).toHaveLength(3));
  });

  it("is resized by the keys and the drag, and the height is stored", async () => {
    const { fixture } = await render();
    const bar = fixture.nativeElement.querySelector("[role=separator]") as HTMLElement;
    expect(bar.getAttribute("aria-orientation")).toBe("horizontal");
    bar.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true }));
    expect(terminalHeight()).toBe(256);
    const pointer = (type: string, clientY: number) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(e, { clientY, button: 0, pointerId: 1 });
      return e;
    };
    bar.dispatchEvent(pointer("pointerdown", 500));
    bar.dispatchEvent(pointer("pointermove", 450));
    bar.dispatchEvent(pointer("pointerup", 450));
    bar.dispatchEvent(pointer("pointermove", 0));
    expect(terminalHeight()).toBe(306);
  });
});
