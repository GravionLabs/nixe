// Replaces `@tauri-apps/plugin-opener` in the `demo` build: records what the app wanted to open.
declare global {
  interface Window {
    __demoOpened?: string[];
  }
}

const record = (what: string): Promise<void> => {
  (window.__demoOpened ??= []).push(what);
  return Promise.resolve();
};

export const openUrl = (url: string): Promise<void> => record(url);
export const openPath = (path: string): Promise<void> => record(path);
export const revealItemInDir = (path: string): Promise<void> => record(path);
