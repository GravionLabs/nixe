import type { ElementRef } from "@angular/core";
import { Component, effect, inject, viewChild } from "@angular/core";
import { HxButton, HxField, HxInput, HxMessage } from "@gravionlabs/helix-ui";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { readText } from "@tauri-apps/plugin-clipboard-manager";

import { CaptureService } from "../../core/capture/capture.service";

/** Event of the backend: the capture window was shown and starts empty. */
export const CAPTURE_SHOWN_EVENT = "capture-shown";

/**
 * The small always-on-top window of the global shortcut (#118). Enter saves, Alt+Enter saves a URL as a link note, Escape discards,
 * `[[` completes note names and Ctrl/Cmd+Shift+V inserts the clipboard.
 */
@Component({
  selector: "app-capture",
  templateUrl: "./capture.component.html",
  styleUrl: "./capture.component.css",
  imports: [HxButton, HxField, HxInput, HxMessage],
})
export class CaptureComponent {
  protected readonly capture = inject(CaptureService);
  private readonly input = viewChild<ElementRef<HTMLTextAreaElement>>("input");
  private unlisten: UnlistenFn | null = null;

  constructor() {
    void this.capture.reset();
    void this.listenForShow();
    // The caret moves after the service changed the text (completion, clipboard).
    effect(() => {
      const caret = this.capture.pendingCaret();
      const el = this.input()?.nativeElement;
      if (caret === null || !el) return;
      queueMicrotask(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
        this.capture.pendingCaret.set(null);
      });
    });
  }

  private async listenForShow(): Promise<void> {
    try {
      this.unlisten = await listen(CAPTURE_SHOWN_EVENT, () => {
        void this.capture.reset();
        this.input()?.nativeElement.focus();
      });
    } catch {
      // not inside Tauri (tests, browser)
    }
  }

  protected onInput(event: Event): void {
    const el = event.target as HTMLTextAreaElement;
    this.capture.edit(el.value, el.selectionStart);
  }

  protected syncCaret(): void {
    const el = this.input()?.nativeElement;
    if (el) this.capture.caret.set(el.selectionStart);
  }

  protected pick(name: string): void {
    this.capture.complete(name);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const completing = this.capture.suggestions().length > 0;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.shiftKey && event.key.toLowerCase() === "v") {
      event.preventDefault();
      const el = this.input()?.nativeElement;
      void this.capture.insertClipboard(
        () => readText(),
        el?.selectionStart ?? this.capture.text().length,
        el?.selectionEnd ?? this.capture.text().length,
      );
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        if (!completing) return;
        this.capture.moveSelection(event.key === "ArrowDown" ? 1 : -1);
        break;
      case "Tab":
        if (!completing) return;
        this.capture.complete();
        break;
      case "Enter":
        if (event.shiftKey || event.isComposing) return;
        if (event.altKey) {
          // Alt+Enter on a URL saves a link note; on other text it does nothing.
          if (this.capture.isLink()) void this.capture.saveLink();
          break;
        }
        if (completing) this.capture.complete();
        else void this.capture.save();
        break;
      case "Escape":
        if (completing) this.capture.edit(this.capture.text(), 0);
        else void this.capture.discard();
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
