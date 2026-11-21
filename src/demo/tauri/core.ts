// Replaces `@tauri-apps/api/core` in the `demo` build (`tsconfig.demo.json`).
import { DemoChannel } from "../kit/backend";
import { demo } from "./instance";

export const invoke = <T>(command: string, args?: Record<string, unknown>): Promise<T> =>
  demo.backend.invoke<T>(command, args);

export { DemoChannel as Channel };

/** The `asset:` URL of a file; the demo vault has no files on a disk to serve. */
export const convertFileSrc = (path: string): string => `/demo-asset${path}`;
