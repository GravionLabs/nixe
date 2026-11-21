// Replaces `@tauri-apps/api/event` in the `demo` build.
import { demo } from "./instance";

export type UnlistenFn = () => void;

export interface Event<T> {
  payload: T;
}

export const listen = <T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> =>
  Promise.resolve(demo.backend.listen(event, handler as (payload: unknown) => void));

export const emit = (event: string, payload?: unknown): Promise<void> => {
  demo.backend.emit(event, payload);
  return Promise.resolve();
};
