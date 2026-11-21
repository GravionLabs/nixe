// Replaces `@tauri-apps/plugin-updater` in the `demo` build: there is never an update. The type is
// the real one (a relative path, so the `paths` entry does not loop back here); it leaves no code.
import type { Update } from "../../../node_modules/@tauri-apps/plugin-updater/dist-js/index";

export type { Update };

export const check = (): Promise<Update | null> => Promise.resolve(null);
