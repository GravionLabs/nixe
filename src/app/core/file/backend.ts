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

export interface Backlink {
  /** Vault-relative path of the note containing the link. */
  source: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
  kind: "link" | "embed" | "markdown";
  /** 1-based line of the link in the source note. */
  line: number;
  /** The trimmed text of that line. */
  context: string;
}

export interface IndexedLink {
  target: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
  kind: "link" | "embed" | "markdown";
  /** Vault-relative path of the target; null when missing or ambiguous. */
  resolved: string | null;
  line: number;
}

export interface SearchSnippet {
  /** 1-based line of the match. */
  line: number;
  /** The line around the match; matches are wrapped in \u0001 … \u0002. */
  text: string;
}

export interface SearchHit {
  /** Vault-relative path. */
  path: string;
  title: string;
  snippets: SearchSnippet[];
}

export interface BrokenLink {
  /** Vault-relative path of the note containing the link. */
  source: string;
  /** 1-based line of the link. */
  line: number;
  target: string;
  kind: "link" | "embed" | "markdown";
  /** The trimmed text of that line. */
  context: string;
}

export interface DuplicateGroup {
  name: string;
  paths: string[];
}

export interface HealthReport {
  brokenLinks: BrokenLink[];
  orphans: { path: string; title: string }[];
  duplicates: DuplicateGroup[];
  /** Vault-relative paths. */
  unusedAttachments: string[];
}

export interface NoteSummary {
  /** Vault-relative path. */
  path: string;
  title: string;
  aliases: string[];
}

/** Where a new note goes, from `.obsidian/app.json`. */
export interface NewNoteLocation {
  location: "root" | "current" | "folder";
  /** Vault-relative folder for `folder`; empty otherwise. */
  folder: string;
}

/** How a link to a note is written (`newLinkFormat` of `.obsidian/app.json`). */
export interface LinkFormat {
  format: "shortest" | "relative" | "absolute";
}

export interface TagCount {
  tag: string;
  count: number;
}

/** A note whose links a rename rewrites. */
export interface RelinkChange {
  /** Vault-relative path of the note after the rename. */
  path: string;
  /** Number of links changed in it. */
  links: number;
}

export interface NoteRecord {
  path: string;
  title: string;
  links: IndexedLink[];
}

/** Typed wrappers around the Rust commands in src-tauri/src/lib.rs. */
export const backend = {
  takePendingFile: () => invoke<string | null>("take_pending_file"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  /** Atomic write; the Rust side only accepts the open note or a note inside the vault. */
  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
  /** Creates an empty file inside the vault; fails when it exists. */
  createFile: (path: string) => invoke<void>("create_file", { path }),
  /** Creates a folder and its missing parents inside the vault. */
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  /** Moves a file or folder inside the vault, fails rather than replace, and rewrites the links to it in one batch. */
  renamePath: (from: string, to: string) => invoke<RelinkChange[]>("rename_path", { from, to }),
  /** The notes whose links a rename would rewrite; changes nothing. */
  relinkPreview: (from: string, to: string) => invoke<RelinkChange[]>("relink_preview", { from, to }),
  /** Moves a file or folder to `.trash/` of the vault; returns the new path. */
  trashPath: (path: string) => invoke<string>("trash_path", { path }),
  newNoteLocation: () => invoke<NewNoteLocation>("new_note_location"),
  /** False when reading the file would replace invalid UTF-8 bytes (editing would lose them). */
  linkFormat: () => invoke<LinkFormat["format"]>("link_format"),
  /** Every tag of the vault with the number of notes using it, most used first. */
  tags: () => invoke<TagCount[]>("tags"),
  isUtf8File: (path: string) => invoke<boolean>("is_utf8_file", { path }),
  isFile: (path: string) => invoke<boolean>("is_file", { path }),
  isDir: (path: string) => invoke<boolean>("is_dir", { path }),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  findWikiRoot: (path: string) => invoke<string>("find_wiki_root", { path }),
  findVaultRoot: (path: string) => invoke<string>("find_vault_root", { path }),
  listVaultFiles: (root: string) => invoke<string[]>("list_vault_files", { root }),
  /** Starts the background scan of the vault index; returns at once. */
  indexStart: (root: string) => invoke<void>("index_start", { root }),
  indexStatus: () => invoke<IndexStatus>("index_status"),
  notes: () => invoke<NoteSummary[]>("notes"),
  backlinks: (path: string) => invoke<Backlink[]>("backlinks", { path }),
  /** Metadata of one indexed note (vault-relative path); null when it is not indexed. */
  noteMeta: (path: string) => invoke<NoteRecord | null>("note_meta", { path }),
  searchNotes: (query: string) => invoke<SearchHit[]>("search_notes", { query }),
  /** Health report of the indexed vault; `exclude` lists vault-relative folders to leave out. */
  vaultHealth: (exclude: string[]) => invoke<HealthReport>("vault_health", { exclude }),
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
