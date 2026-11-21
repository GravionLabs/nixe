import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  ViewChild,
} from "@angular/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { SettingsService } from "../../core/settings/settings.service";
import { TerminalBackend } from "../../core/terminal/terminal-backend";
import {
  MIN_TERMINAL_HEIGHT,
  clampTerminalHeight,
  heightAfterKey,
  maxTerminalHeight,
} from "../../core/terminal/terminal-height";
import { TERMINAL_PRESETS } from "../../core/terminal/terminal-presets";
import { TerminalService } from "../../core/terminal/terminal.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/** A tab at run time: its terminal and its session. `generation` makes output and exit of an old session ignored. */
interface Run {
  readonly key: number;
  readonly el: HTMLElement;
  readonly term: Terminal;
  readonly fit: FitAddon;
  session: number | null;
  generation: number;
  starting: boolean;
  unlisten: (() => void)[];
}

/**
 * The bottom panel with its terminal tabs. The component stays mounted while the terminal is enabled, so
 * hiding the panel keeps the sessions; the first tab opens when the panel is first shown. A session ends
 * when its tab is closed, the terminal is turned off, the vault changes or the app closes.
 */
@Component({
  selector: "app-terminal-panel",
  templateUrl: "./terminal-panel.component.html",
  styleUrl: "./terminal-panel.component.css",
  host: {
    "[class.open]": "terminal.open()",
    "[style.height.px]": "height()",
    "(window:resize)": "onWindowResize()",
  },
})
export class TerminalPanelComponent {
  protected readonly terminal = inject(TerminalService);
  private readonly settings = inject(SettingsService);
  private readonly workspace = inject(WorkspaceService);
  private readonly backend = inject(TerminalBackend);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  // Decorator query: signal queries are not registered when the specs run under the JIT compiler.
  @ViewChild("screens", { static: true }) private screens!: ElementRef<HTMLElement>;
  protected readonly error = signal<string | null>(null);
  protected readonly presets = TERMINAL_PRESETS;
  protected readonly min = MIN_TERMINAL_HEIGHT;

  private readonly windowHeight = signal(window.innerHeight);
  protected readonly max = () => maxTerminalHeight(this.windowHeight());
  protected readonly height = () =>
    clampTerminalHeight(this.settings.terminalHeight(), this.windowHeight());

  private readonly runs = new Map<number, Run>();
  private readonly ready = signal(false);
  private observer: ResizeObserver | null = null;
  private drag: { y: number; height: number } | null = null;
  private root: string | null = null;

  constructor() {
    afterNextRender(() => {
      if (typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => this.refit());
        this.observer.observe(this.host.nativeElement);
      }
      this.ready.set(true);
    });

    // Showing the panel opens the first tab; the tabs and the height are followed.
    effect(() => {
      const open = this.terminal.open();
      const ready = this.ready();
      this.terminal.tabs();
      this.terminal.activeKey();
      this.height();
      untracked(() => this.sync(open && ready));
    });

    // A session belongs to the vault it started in.
    effect(() => {
      const root = this.workspace.vaultRoot();
      untracked(() => {
        if (this.root !== null && root !== this.root) {
          for (const key of this.runs.keys()) this.dispose(key);
          this.terminal.reset();
        }
        this.root = root;
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      for (const key of this.runs.keys()) this.dispose(key);
    });
  }

  /** Brings the terminals in line with the tabs: closes the removed, opens the new, shows the active one. */
  private sync(shown: boolean): void {
    const tabs = this.terminal.tabs();
    for (const key of this.runs.keys()) {
      if (!tabs.some((t) => t.key === key)) this.dispose(key);
    }
    if (!shown) return;
    if (tabs.length === 0) this.terminal.seed();
    const active = this.terminal.activeKey();
    for (const tab of this.terminal.tabs()) {
      if (!this.runs.has(tab.key)) this.create(tab.key);
    }
    for (const [key, run] of this.runs) run.el.style.display = key === active ? "" : "none";
    const run = active === null ? undefined : this.runs.get(active);
    if (!run) return;
    this.refit();
    run.term.focus();
    if (run.session === null && !run.starting) void this.start(run);
  }

  private create(key: number): void {
    const el = document.createElement("div");
    // Created outside the template, so the component styles do not reach it.
    el.style.cssText = "height:100%;padding:4px 8px;box-sizing:border-box";
    el.setAttribute("role", "region");
    el.setAttribute(
      "aria-label",
      this.terminal.tabs().find((t) => t.key === key)?.title ?? "Terminal",
    );
    this.screens.nativeElement.append(el);
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--nixe-font-mono)",
      fontSize: 13,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const run: Run = {
      key,
      el,
      term,
      fit,
      session: null,
      generation: 0,
      starting: false,
      unlisten: [],
    };
    term.onData((data) => this.input(run, data));
    term.onResize(({ rows, cols }) => {
      if (run.session !== null)
        void this.backend.resize(run.session, rows, cols).catch(() => undefined);
    });
    this.runs.set(key, run);
  }

  private refit(): void {
    const key = this.terminal.activeKey();
    const run = key === null ? undefined : this.runs.get(key);
    if (!this.terminal.open() || !run) return;
    try {
      run.fit.fit();
    } catch {
      // the panel has no size yet
    }
  }

  private async start(run: Run): Promise<void> {
    const { term } = run;
    run.starting = true;
    const generation = ++run.generation;
    this.error.set(null);
    try {
      const preset = this.terminal.tabs().find((t) => t.key === run.key)?.preset ?? null;
      const id = await this.backend.open(term.rows, term.cols, preset);
      if (generation !== run.generation) {
        void this.backend.close(id).catch(() => undefined);
        return;
      }
      run.session = id;
      // The shell emits as soon as it runs, so the listeners come first and `attach` starts the output.
      const off = [
        await this.backend.onOutput(id, (bytes) => {
          if (generation === run.generation) term.write(bytes);
        }),
        await this.backend.onExit(id, () => {
          if (generation !== run.generation) return;
          this.releaseListeners(run);
          run.session = null;
          term.write("\r\n[process ended – press a key to start a new shell]\r\n");
        }),
      ];
      if (generation !== run.generation) {
        for (const f of off) f();
        return;
      }
      run.unlisten.push(...off);
      await this.backend.attach(id);
    } catch (err) {
      this.error.set(String(err));
    } finally {
      run.starting = false;
    }
  }

  private input(run: Run, data: string): void {
    if (run.session === null) {
      if (!run.starting && this.terminal.open()) void this.start(run);
      return;
    }
    void this.backend.write(run.session, data).catch((err) => this.error.set(String(err)));
  }

  private releaseListeners(run: Run): void {
    for (const off of run.unlisten.splice(0)) off();
  }

  /** Ends the session of a tab and removes its terminal. */
  private dispose(key: number): void {
    const run = this.runs.get(key);
    if (!run) return;
    this.runs.delete(key);
    run.generation++;
    this.releaseListeners(run);
    const id = run.session;
    run.session = null;
    if (id !== null) void this.backend.close(id).catch(() => undefined);
    run.term.dispose();
    run.el.remove();
  }

  protected onWindowResize(): void {
    this.windowHeight.set(window.innerHeight);
    this.refit();
  }

  protected dragStart(event: PointerEvent): void {
    if (event.button !== 0) return;
    this.drag = { y: event.clientY, height: this.height() };
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    (event.target as HTMLElement).classList.add("dragging");
    event.preventDefault();
  }

  protected dragMove(event: PointerEvent): void {
    if (!this.drag) return;
    // The panel sits at the bottom: dragging up makes it taller.
    this.settings.terminalHeight.set(
      clampTerminalHeight(this.drag.height + (this.drag.y - event.clientY), this.windowHeight()),
    );
  }

  protected dragEnd(event: PointerEvent): void {
    this.drag = null;
    (event.target as HTMLElement).classList.remove("dragging");
  }

  protected key(event: KeyboardEvent): void {
    const next = heightAfterKey(event.key, event.shiftKey, this.height(), this.windowHeight());
    if (next === null) return;
    event.preventDefault();
    this.settings.terminalHeight.set(next);
  }
}
