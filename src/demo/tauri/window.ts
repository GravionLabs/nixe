// Replaces `@tauri-apps/api/window` in the `demo` build: a window that never closes or gets focus.
const none = (_handler: (event: never) => unknown): Promise<() => void> =>
  Promise.resolve(() => {});

export const getCurrentWindow = () => ({
  setTitle: (title: string): Promise<void> => {
    document.title = title;
    return Promise.resolve();
  },
  onCloseRequested: none as (
    handler: (event: { preventDefault(): void }) => unknown,
  ) => Promise<() => void>,
  onFocusChanged: none as (
    handler: (event: { payload: boolean }) => unknown,
  ) => Promise<() => void>,
  close: (): Promise<void> => Promise.resolve(),
  destroy: (): Promise<void> => Promise.resolve(),
});
