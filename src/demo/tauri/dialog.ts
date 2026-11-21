// Replaces `@tauri-apps/plugin-dialog` in the `demo` build: a dialog answers as if it was cancelled.
// A test that needs another answer sets `window.__demoDialog` before the call.
declare global {
  interface Window {
    __demoDialog?: { open?: string | null; save?: string | null; ask?: boolean };
  }
}

export const open = (_options?: unknown): Promise<string | null> =>
  Promise.resolve(window.__demoDialog?.open ?? null);
export const save = (_options?: unknown): Promise<string | null> =>
  Promise.resolve(window.__demoDialog?.save ?? null);
export const ask = (_message: string, _options?: unknown): Promise<boolean> =>
  Promise.resolve(window.__demoDialog?.ask ?? false);
