import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** Directory contains an Azure DevOps `.order` file. */
  hasOrder: boolean;
}

/** Typed wrappers around the Rust commands in src-tauri/src/lib.rs. */
export const backend = {
  takePendingFile: () => invoke<string | null>("take_pending_file"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  isFile: (path: string) => invoke<boolean>("is_file", { path }),
  isDir: (path: string) => invoke<boolean>("is_dir", { path }),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  findWikiRoot: (path: string) => invoke<string>("find_wiki_root", { path }),
  watchFile: (path: string) => invoke<void>("watch_file", { path }),
};

export const OPEN_FILE_EVENT = "open-file-requested";
export const FILE_CHANGED_EVENT = "file-changed";
export const MENU_EVENT = "menu";
