import type { ElementRef } from "@angular/core";
import { Component, inject, signal, viewChild } from "@angular/core";

import { backend } from "../../core/file/backend";
import { LogActionsService } from "../../core/log/log-actions.service";

/** The log tab (#412): `nixe.log` as a read-only text with the newest lines at the end. */
@Component({
  selector: "app-log",
  templateUrl: "./log.component.html",
  styleUrl: "./log.component.css",
})
export class LogComponent {
  private readonly actions = inject(LogActionsService);
  private readonly body = viewChild<ElementRef<HTMLElement>>("body");

  protected readonly text = signal("");
  protected readonly state = signal<"loading" | "ready" | "error">("loading");

  constructor() {
    void this.reload();
  }

  protected async reload(): Promise<void> {
    this.state.set("loading");
    try {
      this.text.set(await backend.logRead());
      this.state.set("ready");
      // The end of the log is what matters: scroll there once the text is in.
      queueMicrotask(() => setTimeout(() => this.toEnd(), 0));
    } catch {
      this.state.set("error");
    }
  }

  protected copy(): void {
    void this.actions.copy();
  }

  protected reveal(): void {
    void this.actions.reveal();
  }

  private toEnd(): void {
    const el = this.body()?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
