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

/** `.obsidian/daily-notes.json`; a key it does not set is null. */
export interface DailyNotesConfig {
  folder: string | null;
  format: string | null;
  template: string | null;
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

export interface GitChange {
  /** Vault-relative path. */
  path: string;
  kind: "added" | "modified" | "deleted";
}

/** What one sync did. */
export interface SyncReport {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  /** Vault-relative notes that both sides changed; each kept both versions. */
  conflicts: string[];
}

/** A note changed on two sides: the original holds the remote text, the copy the local text. */
export interface ConflictPair {
  original: string;
  copy: string;
}

export interface GitStatus {
  /** Null on a detached HEAD. */
  branch: string | null;
  changes: GitChange[];
  ahead: number;
  behind: number;
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
  /** The template folder of `.obsidian/templates.json` (vault-relative); null when it names none. */
  templateFolder: () => invoke<string | null>("template_folder"),
  /** The Daily notes settings of `.obsidian/daily-notes.json`. */
  dailyNotesConfig: () => invoke<DailyNotesConfig>("daily_notes_config"),
  /** False when reading the file would replace invalid UTF-8 bytes (editing would lose them). */
  linkFormat: () => invoke<LinkFormat["format"]>("link_format"),
  /** Saves pasted bytes into the attachment folder of `note`; returns the vault-relative path. */
  saveAttachment: (note: string, name: string, bytes: number[]) =>
    invoke<string>("save_attachment", { note, name, bytes }),
  /** Brings a dropped file into the vault (copied unless it is inside); returns the vault-relative path. */
  importAttachment: (note: string, source: string) => invoke<string>("import_attachment", { note, source }),
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
  /** Git state of the vault; null when the vault is not a Git repository. */
  gitVaultStatus: () => invoke<GitStatus | null>("git_vault_status"),
  /**
   * Stages everything and commits; returns the commit id. An empty `message` gives
   * `vault backup: <timestamp>`; `name` and `email` are used when the Git config has no author.
   */
  gitVaultCommit: (message: string | null, name: string | null, email: string | null) =>
    invoke<string>("git_vault_commit", { message, name, email }),
  /**
   * Sync: commits open changes, fetches, rebases the local commits onto the remote branch and
   * pushes. A conflict never stops it: the remote text stays in the note and the local text goes
   * to `Note (conflict <date> <device>).md` (see `SyncReport.conflicts`). A missing or rejected token
   * rejects with `auth-required:<host>` / `auth-failed:<host>`.
   */
  gitVaultSync: (name: string | null, email: string | null) =>
    invoke<SyncReport>("git_vault_sync", { name, email }),
  /** The conflict pair a note belongs to (as the original or the copy); null for other notes. */
  conflictPair: (path: string) => invoke<ConflictPair | null>("conflict_pair", { path }),
  /**
   * Keeps the text of this note (`this`) or of the other half of the pair (`other`): the original
   * gets that text and the copy moves to `.trash/`. Returns the path of the original.
   */
  resolveConflict: (path: string, keep: "this" | "other") => invoke<string>("resolve_conflict", { path, keep }),
  /** Whether an access token is stored in the OS keychain for the remote host. The token is never returned. */
  gitTokenStatus: (host: string) => invoke<boolean>("git_token_status", { host }),
  /** Stores or replaces the token of a remote host in the OS keychain. */
  gitTokenSet: (host: string, token: string) => invoke<void>("git_token_set", { host, token }),
  gitTokenDelete: (host: string) => invoke<void>("git_token_delete", { host }),
  /**
   * Clones a GitHub HTTPS url into `<parent>/<repository name>` and returns that folder. Progress comes
   * as `CLONE_PROGRESS_EVENT`. A failed or cancelled clone removes the folder it created. A missing or
   * rejected token rejects with `auth-required:<host>` / `auth-failed:<host>`, a cancel with `cancelled`.
   */
  gitCloneVault: (url: string, parent: string) => invoke<string>("git_clone_vault", { url, parent }),
  /** Stops the running clone. */
  gitCloneCancel: () => invoke<void>("git_clone_cancel"),
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
/** Emitted with a `CloneProgress` while a vault is cloned. */
export const CLONE_PROGRESS_EVENT = "git-clone-progress";
export interface CloneProgress {
  received: number;
  total: number;
}
/** Error text of a clone the user cancelled. */
export const CLONE_CANCELLED = "cancelled";
