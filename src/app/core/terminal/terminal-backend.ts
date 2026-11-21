import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";

/** The commands and events of the PTY in the Rust core (`terminal.rs`); a spec provides a fake. */
@Injectable({ providedIn: "root" })
export class TerminalBackend {
  open(rows: number, cols: number): Promise<number> {
    return invoke<number>("terminal_open", { rows, cols });
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
