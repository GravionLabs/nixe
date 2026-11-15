import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** Directory contains an Azure DevOps `.order` file. */
  hasOrder: boolean;
}

export interface IndexStatus {
  state: "idle" | "scanning" | "ready" | "error";
  done: number;
  total: number;
  notes: number;
  error: string | null;
}

/** Typed wrappers around the Rust commands in src-tauri/src/lib.rs. */
export const backend = {
  takePendingFile: () => invoke<string | null>("take_pending_file"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  isFile: (path: string) => invoke<boolean>("is_file", { path }),
  isDir: (path: string) => invoke<boolean>("is_dir", { path }),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  findWikiRoot: (path: string) => invoke<string>("find_wiki_root", { path }),
  findVaultRoot: (path: string) => invoke<string>("find_vault_root", { path }),
  listVaultFiles: (root: string) => invoke<string[]>("list_vault_files", { root }),
  /** Starts the background scan of the vault index; returns at once. */
  indexStart: (root: string) => invoke<void>("index_start", { root }),
  indexStatus: () => invoke<IndexStatus>("index_status"),
  watchFile: (path: string) => invoke<void>("watch_file", { path }),
};

export const OPEN_FILE_EVENT = "open-file-requested";
/** Piped content (`nixe -`) lives in this temp file, see `stdin_file_path` in lib.rs. */
export const STDIN_FILE_SUFFIX = "/nixe-stdin/stdin.md";
/** Emitted with an `IndexStatus` while the vault index is built. */
export const INDEX_EVENT = "index-status";
export const FILE_CHANGED_EVENT = "file-changed";
/** Emitted with a `VaultChange[]` after the index applied a batch of vault file changes. */
export const VAULT_CHANGED_EVENT = "vault-changed";
export type VaultChangeKind = "create" | "modify" | "remove" | "rename";
export interface VaultChange {
  path: string;
  kind: VaultChangeKind;
  /** Old path of a rename. */
  from?: string;
}
export const MENU_EVENT = "menu";
