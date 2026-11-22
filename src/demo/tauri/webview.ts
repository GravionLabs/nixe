// Replaces `@tauri-apps/api/webview` in the `demo` build: nothing is dropped from outside.
export type DragDropEvent =
  | { type: "enter" | "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "leave" };

export const getCurrentWebview = () => ({
  onDragDropEvent: (_handler: (event: { payload: DragDropEvent }) => void): Promise<() => void> =>
    Promise.resolve(() => {}),
});
