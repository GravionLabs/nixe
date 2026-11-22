// The stand-in of `@tauri-apps/api/core` and `/event` for the e2e specs (#403): the specs mock both
// modules with it (`vi.mock("@tauri-apps/api/core", () => import("./mock"))`). It talks to the demo
// that `useDemo` set last, so no spec sees the writes of another.
import { DemoChannel } from "../kit/backend";
import { createNixeDemo, type NixeDemo } from "../nixe/demo";

let current: NixeDemo = createNixeDemo();

/** Makes a fresh demo the one the app talks to. */
export function useDemo(): NixeDemo {
  return (current = createNixeDemo());
}

export const invoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  current.backend.invoke<T>(command, args);
export const listen = <T>(event: string, handler: (event: { payload: T }) => void) =>
  Promise.resolve(current.backend.listen(event, handler as (payload: unknown) => void));
export const Channel = DemoChannel;
