import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";

/** The commands and events of the PTY in the Rust core (`terminal.rs`); a spec provides a fake. */
@Injectable({ providedIn: "root" })
export class TerminalBackend {
  /** Starts the shell, or the CLI of `preset`, in the vault root. */
  open(rows: number, cols: number, preset: string | null = null): Promise<number> {
    return invoke<number>("terminal_open", { rows, cols, preset });
  }

  /** Rejects with an install hint when the CLI of preset `id` is not installed. */
  checkPreset(id: string): Promise<void> {
    return invoke<void>("terminal_preset_check", { id });
  }

  /** Starts the output of session `id`; call it once the listeners are registered. */
  attach(id: number): Promise<void> {
    return invoke<void>("terminal_attach", { id });
  }

  write(id: number, data: string): Promise<void> {
    return invoke<void>("terminal_write", { id, data });
  }

  resize(id: number, rows: number, cols: number): Promise<void> {
    return invoke<void>("terminal_resize", { id, rows, cols });
  }

  close(id: number): Promise<void> {
    return invoke<void>("terminal_close", { id });
  }

  /** The output of session `id` as raw bytes. */
  onOutput(id: number, handler: (bytes: Uint8Array) => void): Promise<UnlistenFn> {
    return listen<{ data: string }>(`terminal-output-${id}`, (e) =>
      handler(decodeBase64(e.payload.data)),
    );
  }

  /** The shell of session `id` has ended. */
  onExit(id: number, handler: () => void): Promise<UnlistenFn> {
    return listen(`terminal-exit-${id}`, () => handler());
  }
}

/** Decodes the base64 of an output event; a read may end inside a UTF-8 sequence, so these stay bytes. */
export function decodeBase64(data: string): Uint8Array {
  const raw = atob(data);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
