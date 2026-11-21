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
import { TerminalService } from "../../core/terminal/terminal.service";
import { WorkspaceService } from "../../core/workspace/workspace.service";

/**
 * The bottom panel with one terminal. The component stays mounted while the terminal is enabled, so
 * hiding the panel keeps the session; the session starts when the panel is first shown and ends when
 * the terminal is turned off, the vault changes or the app closes.
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
  @ViewChild("screen", { static: true }) private screen!: ElementRef<HTMLElement>;
  protected readonly error = signal<string | null>(null);
  protected readonly min = MIN_TERMINAL_HEIGHT;

  private readonly windowHeight = signal(window.innerHeight);
  protected readonly max = () => maxTerminalHeight(this.windowHeight());
  protected readonly height = () =>
    clampTerminalHeight(this.settings.terminalHeight(), this.windowHeight());

  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  private session: number | null = null;
  /** Counts the sessions started, so output and exit of an old one are ignored. */
  private generation = 0;
  private starting = false;
  private unlisten: (() => void)[] = [];
  private observer: ResizeObserver | null = null;
  private drag: { y: number; height: number } | null = null;
  private root: string | null = null;

  constructor() {
    afterNextRender(() => {
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "var(--nixe-font-mono)",
        fontSize: 13,
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(this.screen.nativeElement);
      term.onData((data) => this.input(data));
      term.onResize(({ rows, cols }) => {
        if (this.session !== null)
          void this.backend.resize(this.session, rows, cols).catch(() => undefined);
      });
      this.term = term;
      this.fit = fit;
      if (typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => this.refit());
        this.observer.observe(this.host.nativeElement);
      }
      this.shown(this.terminal.open());
    });

    // Showing the panel starts the session and focuses it; the height follows the stored one.
    effect(() => {
      const open = this.terminal.open();
      this.height();
      untracked(() => this.shown(open));
    });

    // A session belongs to the vault it started in.
    effect(() => {
      const root = this.workspace.vaultRoot();
      untracked(() => {
        if (this.root !== null && root !== this.root) this.endSession(true);
        this.root = root;
      });
    });

    inject(DestroyRef).onDestroy(() => {
      this.observer?.disconnect();
      this.endSession(false);
      this.term?.dispose();
      this.term = null;
    });
  }

  private shown(open: boolean): void {
    if (!open || !this.term) return;
    this.refit();
    this.term.focus();
    if (this.session === null && !this.starting) void this.start();
  }

  private refit(): void {
    if (!this.terminal.open() || !this.term) return;
    try {
      this.fit?.fit();
    } catch {
      // the panel has no size yet
    }
  }

  private async start(): Promise<void> {
    const term = this.term;
    if (!term) return;
    this.starting = true;
    const generation = ++this.generation;
    this.error.set(null);
    try {
      const id = await this.backend.open(term.rows, term.cols);
      if (generation !== this.generation || this.term !== term) {
        void this.backend.close(id).catch(() => undefined);
        return;
      }
      this.session = id;
      // The shell emits as soon as it runs, so the listeners come first and `attach` starts the output.
      const off = [
        await this.backend.onOutput(id, (bytes) => {
          if (generation === this.generation) term.write(bytes);
        }),
        await this.backend.onExit(id, () => {
          if (generation !== this.generation) return;
          this.releaseListeners();
          this.session = null;
          term.write("\r\n[process ended – press a key to start a new shell]\r\n");
        }),
      ];
      if (generation !== this.generation) {
        for (const f of off) f();
        return;
      }
      this.unlisten.push(...off);
      await this.backend.attach(id);
    } catch (err) {
      this.error.set(String(err));
    } finally {
      this.starting = false;
    }
  }

  private input(data: string): void {
    if (this.session === null) {
      if (!this.starting && this.terminal.open()) void this.start();
      return;
    }
    void this.backend.write(this.session, data).catch((err) => this.error.set(String(err)));
  }

  private releaseListeners(): void {
    for (const off of this.unlisten.splice(0)) off();
  }

  /** Ends the session; `clear` also empties the screen for the next one. */
  private endSession(clear: boolean): void {
    this.generation++;
    this.releaseListeners();
    const id = this.session;
    this.session = null;
    if (id !== null) void this.backend.close(id).catch(() => undefined);
    if (clear) this.term?.reset();
    if (clear && this.terminal.open()) this.shown(true);
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
