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
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

import { SettingsService } from "../../core/settings/settings.service";
import { TerminalBackend } from "../../core/terminal/terminal-backend";
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
  async open(rows: number, cols: number) {
    this.opened.push([rows, cols]);
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
        {
          provide: TerminalService,
          useValue: {
            supported: true,
            open: () => terminalEnabled() && terminalVisible() && vaultRoot() !== null,
          },
        },
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
