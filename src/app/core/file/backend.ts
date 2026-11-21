import { invoke } from "@tauri-apps/api/core";
import type { CssFile } from "../appearance/appearance-core";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** Directory contains an Azure DevOps `.order` file. */
  hasOrder: boolean;
  /** Last modification in milliseconds since the epoch; 0 when unknown. */
  modified: number;
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

/** A note close to another one, ranked in the Rust index. */
export interface RelatedNote {
  /** Vault-relative path. */
  path: string;
  title: string;
  score: number;
  /** Why it is related, strongest first: `links here`, `2 shared tags`, `both linked from X`. */
  reasons: string[];
}

/** A plain-text mention of the title or an alias of a note in another note. */
export interface UnlinkedMention {
  /** Vault-relative path of the note holding the mention. */
  source: string;
  /** 1-based line. */
  line: number;
  /** Byte range of the mention in that line. */
  start: number;
  end: number;
  /** The trimmed line. */
  context: string;
  /** The mention as written. */
  text: string;
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
  /** Modification time of the file, milliseconds since the Unix epoch. */
  modified: number;
  /** Matching lines of the note; `snippets` holds only the first few. */
  matches: number;
  snippets: SearchSnippet[];
  /** Name of the workspace root the note is in; set by a search over a workspace only (#117). */
  root?: string;
  /** Absolute path of that root; `path` is relative to it. */
  rootPath?: string;
}

/** A folder of the workspace a search or the quick switcher covers. */
export interface RootArg {
  path: string;
  name: string;
}

/** A note of a workspace, with its root. */
export interface WorkspaceNote extends NoteSummary {
  root: string;
  rootPath: string;
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

/** A setting that Obsidian also has, read from the vault. */
export interface ObsidianSetting {
  id: string;
  label: string;
  /** The value in effect; null when the file does not set it. */
  value: string | null;
  /** The file it comes from, vault-relative. */
  source: string;
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

/** What the note composer does to a note (#113). */
export type ComposeAction = "create" | "append" | "update" | "trash";

export interface ReplaceOptions {
  find: string;
  replace: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface Replacement {
  /** 0-based number of the match in its note. */
  index: number;
  /** 1-based line where the match starts. */
  line: number;
  before: string;
  after: string;
}

export interface NoteReplacements {
  /** Vault-relative path. */
  path: string;
  /** Matches in the note, also those beyond the listed ones. */
  count: number;
  replacements: Replacement[];
}

export interface ReplaceExclusions {
  notes: string[];
  /** `[note, match index]`. */
  matches: [string, number][];
}

export interface ReplaceApplied {
  notes: number;
  replacements: number;
  paths: string[];
}

export interface ComposeChange {
  /** Vault-relative path. */
  path: string;
  action: ComposeAction;
  /** Number of links rewritten in the note. */
  links: number;
}

/** The text an extraction moves: a selection (UTF-16 offsets and its text) or a heading's section. */
export type ExtractWhat =
  | { kind: "selection"; start: number; end: number; expected: string }
  | { kind: "heading"; line: number };

export interface NoteRecord {
  path: string;
  title: string;
  links: IndexedLink[];
}

export interface GitChange {
  /** Vault-relative path. */
  path: string;
  kind: "added" | "modified" | "deleted";
  /** A new note Git does not track yet; only the working-tree status sets it. */
  untracked?: boolean;
}

/** A branch that waits for review (#108). */
export interface ReviewBranch {
  /** Without the remote name: `claude/tidy-inbox`. */
  name: string;
  /** The tip commit; the revision for the changes and the "after" text. */
  tip: string;
  /** Only on a remote, not a local branch. */
  remote: boolean;
  author: string;
  /** Seconds since the epoch. */
  time: number;
  /** Commit messages the branch is ahead by, newest first. */
  messages: string[];
  ahead: number;
  notes: number;
}

/** The notes a branch changed against its merge base with HEAD. */
export interface ReviewChanges {
  /** The merge base: the "before" side of every note. */
  base: string;
  changes: GitChange[];
}

/** One block of changed lines of a note of a review branch (#109). */
export interface ReviewHunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The lines of the merge base. */
  old: string;
  /** The lines of the branch. */
  new: string;
}

export interface HunkDecision {
  index: number;
  accept: boolean;
  /** The edited replacement; absent takes the lines of the branch. */
  text?: string;
}

export interface NoteDecision {
  path: string;
  /** For a note without hunks. */
  accepted: boolean;
  hunks: HunkDecision[];
  /** How a conflicting note ends. */
  resolve?: "mine" | "branch";
}

/** A note that cannot be merged cleanly: both versions (null = deleted). */
export interface ReviewConflict {
  path: string;
  mine: string | null;
  branch: string | null;
}

export interface ReviewOutcome {
  commit: string | null;
  applied: string[];
  conflicts: ReviewConflict[];
  branchDeleted: boolean;
  warning: string | null;
}

/** What one sync did. */
export interface SyncReport {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  /** HEAD before the pull when it brought changes: where "what changed since the sync" starts. */
  pulledFrom?: string | null;
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
  /** Whether the repository has a remote to sync with. */
  hasRemote: boolean;
}

/** One commit of the vault log. */
export interface VaultCommit {
  id: string;
  author: string;
  /** Seconds since the epoch. */
  time: number;
  message: string;
}

/** One commit that touched a note. */
export interface HistoryEntry {
  id: string;
  author: string;
  /** Seconds since the epoch. */
  time: number;
  message: string;
  /** The note's path in this commit (differs after a rename). */
  path: string;
  parent: string | null;
  /** The note's path in the parent commit. */
  parentPath: string;
  /** The kind of vault operation (`rename`, `move`, `delete`, `merge`, `extract`) that wrote the commit. */
  operation: string | null;
}

/** The Git author of the settings, used when the Git config names none. */
export interface GitAuthor {
  name: string | null;
  email: string | null;
}

/** A vault operation that one Git commit holds (#241). */
export interface VaultOperation {
  id: string;
  kind: string;
  /** First line of the commit message, e.g. `rename: A -> B, links in 9 notes`. */
  message: string;
}

/** A note that a recent commit deleted. */
export interface DeletedNote {
  path: string;
  /** The commit that deleted it. */
  id: string;
  /** The parent of that commit: the last version of the note. */
  parent: string;
  author: string;
  time: number;
  message: string;
}

/** Typed wrappers around the Rust commands in src-tauri/src/lib.rs. */
export type RootKind = "obsidian" | "wiki" | "folder";

export interface WorkspaceRoot {
  path: string;
  name: string;
  kind: RootKind;
}

export interface Workspace {
  name: string;
  roots: WorkspaceRoot[];
}

export interface ResolvedLink {
  root: string;
  path: string;
}

export const backend = {
  takePendingFile: () => invoke<string | null>("take_pending_file"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  /** Atomic write; the Rust side only accepts the open note or a note inside the vault. */
  writeTextFile: (path: string, content: string) =>
    invoke<void>("write_text_file", { path, content }),
  /** Creates an empty file inside the vault; fails when it exists. */
  createFile: (path: string) => invoke<void>("create_file", { path }),
  /** Creates a folder and its missing parents inside the vault. */
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  /** Moves a file or folder inside the vault, fails rather than replace, and rewrites the links to it in one batch. */
  renamePath: (from: string, to: string, author?: GitAuthor) =>
    invoke<RelinkChange[]>("rename_path", { from, to, ...author }),
  /** The last vault operation that is not undone yet; null without Git (#241). */
  lastVaultOperation: () => invoke<VaultOperation | null>("last_vault_operation"),
  /** Reverts the last vault operation as a new commit; rejects when it conflicts with later changes. */
  undoVaultOperation: (author?: GitAuthor) =>
    invoke<VaultOperation>("undo_vault_operation", { ...author }),
  /**
   * Takes the changes of one note back (#319): the saved version returns, a new note is removed.
   * One vault operation, so `undoVaultOperation` brings the discarded state back.
   */
  /**
   * Puts the version of `from` at `revision` into the note `path` as one operation commit (#324);
   * the current state is committed first and `undoVaultOperation` brings it back.
   */
  gitRestoreNote: (path: string, from: string, revision: string, author?: GitAuthor) =>
    invoke<VaultOperation>("git_restore_note", { path, from, revision, ...author }),
  gitDiscardNote: (path: string, author?: GitAuthor) =>
    invoke<VaultOperation>("git_discard_note", { path, ...author }),
  /** The notes an extraction into `target` would change; changes nothing. */
  extractPreview: (source: string, target: string, what: ExtractWhat, embed: boolean) =>
    invoke<ComposeChange[]>("extract_preview", { source, target, what, embed }),
  /** Moves the text into `target` (created when missing) and leaves a link or an embed. */
  extractText: (
    source: string,
    target: string,
    what: ExtractWhat,
    embed: boolean,
    author?: GitAuthor,
  ) => invoke<ComposeChange[]>("extract_text", { source, target, what, embed, ...author }),
  /** The notes a merge of `source` into `target` would change; changes nothing. */
  mergePreview: (source: string, target: string) =>
    invoke<ComposeChange[]>("merge_preview", { source, target }),
  /** Appends `source` to `target`, rewrites the links to it and moves it to `.trash/`. */
  mergeNote: (source: string, target: string, author?: GitAuthor) =>
    invoke<ComposeChange[]>("merge_note", { source, target, ...author }),
  /** Every replacement a find and replace would make, per note; changes nothing. */
  replacePreview: (options: ReplaceOptions) =>
    invoke<NoteReplacements[]>("replace_preview", { options }),
  /** Replaces in the vault as one batch; in a Git repository the open changes are committed first. */
  replaceApply: (
    options: ReplaceOptions,
    exclusions: ReplaceExclusions,
    name: string | null,
    email: string | null,
  ) => invoke<ReplaceApplied>("replace_apply", { options, exclusions, name, email }),
  /** The notes whose links a rename would rewrite; changes nothing. */
  relinkPreview: (from: string, to: string) =>
    invoke<RelinkChange[]>("relink_preview", { from, to }),
  /** Moves a file or folder to `.trash/` of the vault; returns the new path. */
  trashPath: (path: string, author?: GitAuthor) =>
    invoke<string>("trash_path", { path, ...author }),
  newNoteLocation: () => invoke<NewNoteLocation>("new_note_location"),
  /** The template folder of `.obsidian/templates.json` (vault-relative); null when it names none. */
  templateFolder: () => invoke<string | null>("template_folder"),
  /** The Daily notes settings of `.obsidian/daily-notes.json`. */
  dailyNotesConfig: () => invoke<DailyNotesConfig>("daily_notes_config"),
  /** False when reading the file would replace invalid UTF-8 bytes (editing would lose them). */
  /** Writes the captured text to the daily note or the inbox (#118); returns the note. */
  captureSave: (text: string) => invoke<string>("capture_save", { text }),
  /** Note names of the vault for the `[[` completion of the capture window. */
  captureNoteNames: () => invoke<string[]>("capture_note_names"),
  /** The title of the page at a URL; null when it cannot be fetched within two seconds. */
  captureLinkTitle: (url: string) => invoke<string | null>("capture_link_title", { url }),
  captureHide: () => invoke<void>("capture_hide"),
  /** Registers the global shortcut of the settings file and creates or removes the window. */
  captureApply: () => invoke<void>("capture_apply"),
  /** The app settings file (`settings.json` in the app config directory); null before the first save. */
  readAppSettings: () => invoke<string | null>("read_app_settings"),
  writeAppSettings: (content: string) => invoke<void>("write_app_settings", { content }),
  /** The `.css` files of `themes` or `snippets` in the app config directory (#114). */
  readAppearance: (kind: "themes" | "snippets") => invoke<CssFile[]>("read_appearance", { kind }),
  /** The app config directory, which holds `themes/` and `snippets/`. */
  appearanceDir: () => invoke<string>("appearance_dir"),
  /** The fold state (`folds.json` in the app data directory, not in the vault); null before the first save. */
  readFolds: () => invoke<string | null>("read_folds"),
  writeFolds: (content: string) => invoke<void>("write_folds", { content }),
  /** `.obsidian/bookmarks.json` of the vault; null when it has none. */
  readVaultBookmarks: () => invoke<string | null>("read_vault_bookmarks"),
  /** Replaces `.obsidian/bookmarks.json`; rejects for a vault without `.obsidian/`. */
  writeVaultBookmarks: (content: string) => invoke<void>("write_vault_bookmarks", { content }),
  /** The bookmarks of all vaults in the app data directory; null before the first save. */
  readAppBookmarks: () => invoke<string | null>("read_app_bookmarks"),
  writeAppBookmarks: (content: string) => invoke<void>("write_app_bookmarks", { content }),
  /** Shows shortcuts in the native menu: accelerator per menu item id, null for none. */
  setMenuShortcuts: (shortcuts: Record<string, string | null>) =>
    invoke<number>("set_menu_shortcuts", { shortcuts }),
  /** The Obsidian settings of the open vault with the file each one comes from. */
  obsidianSettings: () => invoke<ObsidianSetting[]>("obsidian_settings"),
  linkFormat: () => invoke<LinkFormat["format"]>("link_format"),
  /** Saves pasted bytes into the attachment folder of `note`; returns the vault-relative path. */
  saveAttachment: (note: string, name: string, bytes: number[]) =>
    invoke<string>("save_attachment", { note, name, bytes }),
  /** Brings a dropped file into the vault (copied unless it is inside); returns the vault-relative path. */
  importAttachment: (note: string, source: string) =>
    invoke<string>("import_attachment", { note, source }),
  /** Every tag of the vault with the number of notes using it, most used first. */
  tags: () => invoke<TagCount[]>("tags"),
  isUtf8File: (path: string) => invoke<boolean>("is_utf8_file", { path }),
  isFile: (path: string) => invoke<boolean>("is_file", { path }),
  /** Whether anything is at `path`, also what the file tree hides. */
  pathExists: (path: string) => invoke<boolean>("path_exists", { path }),
  isDir: (path: string) => invoke<boolean>("is_dir", { path }),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  findWikiRoot: (path: string) => invoke<string>("find_wiki_root", { path }),
  findVaultRoot: (path: string) => invoke<string>("find_vault_root", { path }),
  listVaultFiles: (root: string) => invoke<string[]>("list_vault_files", { root }),
  /** The names of the saved workspaces (app data directory, never the folders). */
  workspaceList: () => invoke<string[]>("workspace_list"),
  workspaceLoad: (name: string) => invoke<Workspace>("workspace_load", { name }),
  workspaceSave: (workspace: Workspace) => invoke<void>("workspace_save", { workspace }),
  workspaceDelete: (name: string) => invoke<void>("workspace_delete", { name }),
  /** `workspace` with the folder added as a root; the backend detects its kind. */
  workspaceAddRoot: (workspace: Workspace, path: string) =>
    invoke<Workspace>("workspace_add_root", { workspace, path }),
  /** Resolves link targets of a note in root `from`; `Root name:Note` reaches another root. */
  workspaceResolveLinks: (workspace: Workspace, from: string, targets: string[]) =>
    invoke<(ResolvedLink | null)[]>("workspace_resolve_links", { workspace, from, targets }),
  /** Starts the background scan of the vault index; returns at once. */
  indexStart: (root: string) => invoke<void>("index_start", { root }),
  indexStatus: () => invoke<IndexStatus>("index_status"),
  notes: () => invoke<NoteSummary[]>("notes"),
  backlinks: (path: string) => invoke<Backlink[]>("backlinks", { path }),
  /** Notes close to the note, nearest first, each with the reasons. */
  relatedNotes: (path: string) => invoke<RelatedNote[]>("related_notes", { path }),
  /** Plain-text mentions of the title or an alias of the note, computed on demand. */
  unlinkedMentions: (path: string) => invoke<UnlinkedMention[]>("unlinked_mentions", { path }),
  /** Turns a mention into a `[[link]]` to `target` (both vault-relative paths). */
  linkMention: (target: string, mention: UnlinkedMention) =>
    invoke<void>("link_mention", {
      source: mention.source,
      target,
      line: mention.line,
      start: mention.start,
      end: mention.end,
      text: mention.text,
    }),
  /** Metadata of one indexed note (vault-relative path); null when it is not indexed. */
  noteMeta: (path: string) => invoke<NoteRecord | null>("note_meta", { path }),
  searchNotes: (query: string) => invoke<SearchHit[]>("search_notes", { query }),
  /** Brings the index of every root up to date; resolves when all are done (#117). */
  workspaceIndex: (roots: RootArg[]) => invoke<void>("workspace_index", { roots }),
  /** Search over all roots; each hit names its root. `root:name` in the query narrows it. */
  searchWorkspace: (roots: RootArg[], query: string) =>
    invoke<SearchHit[]>("search_workspace", { roots, query }),
  /** The notes of all roots, for the quick switcher. */
  workspaceNotes: (roots: RootArg[]) => invoke<WorkspaceNote[]>("workspace_notes", { roots }),
  /** Health report of the indexed vault; `exclude` lists vault-relative folders to leave out. */
  vaultHealth: (exclude: string[]) => invoke<HealthReport>("vault_health", { exclude }),
  /** Git state of the vault; null when the vault is not a Git repository. */
  gitVaultStatus: () => invoke<GitStatus | null>("git_vault_status"),
  /** Commits that touched a vault-relative note, newest first, following renames; `offset`/`limit` page. */
  gitNoteHistory: (path: string, offset: number, limit: number) =>
    invoke<HistoryEntry[]>("git_note_history", { path, offset, limit }),
  /** A note at a commit (empty when it did not exist there), or the file on disk for `rev: null`. */
  gitNoteVersion: (path: string, rev: string | null) =>
    invoke<string>("git_note_version", { path, rev }),
  /** Notes deleted by the last `commits` commits and not present now, newest first. */
  /** The notes (added, modified, deleted) that differ between the commit `from` and `to` (default HEAD). */
  gitChangesBetween: (from: string, to: string | null = null) =>
    invoke<GitChange[]>("git_changes_between", { from, to }),
  /** The newest commit at or before `time` (seconds since the epoch); null when the history starts later. */
  gitRevAt: (time: number) => invoke<string | null>("git_rev_at", { time }),
  /** The commits of the vault, newest first; `offset`/`limit` page. */
  gitVaultLog: (offset: number, limit: number) =>
    invoke<VaultCommit[]>("git_vault_log", { offset, limit }),
  /** Branches named with `prefix` that are ahead of the working branch, newest first. */
  gitReviewBranches: (prefix: string) => invoke<ReviewBranch[]>("git_review_branches", { prefix }),
  /** The notes the branch tip `rev` changed against the merge base with HEAD. */
  gitReviewChanges: (rev: string) => invoke<ReviewChanges>("git_review_changes", { rev }),
  /** The hunks of one note of the branch tip against the merge base. */
  gitReviewHunks: (tip: string, path: string) =>
    invoke<ReviewHunk[]>("git_review_hunks", { tip, path }),
  /**
   * Commits the accepted changes onto the working branch and, with `deleteBranch`, deletes the
   * branch locally and on the remote. Conflicts come back in the outcome; nothing is changed then.
   */
  gitReviewFinish: (
    branch: string,
    tip: string,
    decisions: NoteDecision[],
    deleteBranch: boolean,
    name: string | null,
    email: string | null,
  ) =>
    invoke<ReviewOutcome>("git_review_finish", {
      branch,
      tip,
      decisions,
      deleteBranch,
      name,
      email,
    }),
  /** The saved, unfinished decisions of a branch (text); null when there are none. */
  gitReviewStateLoad: (branch: string) =>
    invoke<string | null>("git_review_state_load", { branch }),
  /** Saves the decisions of a branch; null removes them. */
  gitReviewStateSave: (branch: string, content: string | null) =>
    invoke<void>("git_review_state_save", { branch, content }),
  gitDeletedNotes: (commits: number) => invoke<DeletedNote[]>("git_deleted_notes", { commits }),
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
  resolveConflict: (path: string, keep: "this" | "other") =>
    invoke<string>("resolve_conflict", { path, keep }),
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
  gitCloneVault: (url: string, parent: string) =>
    invoke<string>("git_clone_vault", { url, parent }),
  /** Stops the running clone. */
  gitCloneCancel: () => invoke<void>("git_clone_cancel"),
  watchFile: (path: string) => invoke<void>("watch_file", { path }),
  /** Writes an exported file to the place the user (or `--out`) chose; any path, replaces a file. */
  writeExportFile: (path: string, content: string) =>
    invoke<void>("write_export_file", { path, content }),
  /** Writes `folder` of a vault as a static website into `out`; the number of pages. */
  exportSite: (folder: string, out: string, exclude: string[] = []) =>
    invoke<number>("export_site", { folder, out, exclude }),
  /** The file as a `data:` URI; null when it cannot be read. */
  readDataUri: (path: string) => invoke<string | null>("read_data_uri", { path }),
  /** A file of the frontend bundle (a KaTeX font) as a `data:` URI; null when the bundle has none. */
  readBundledDataUri: (path: string) => invoke<string | null>("read_bundled_data_uri", { path }),
  /** The export `nixe export` asked for, once. */
  takePendingExport: () => invoke<ExportRequest | null>("take_pending_export"),
  /** Ends a headless `nixe export`: the message goes to stdout (code 0) or stderr, then the process exits. */
  finishExport: (code: number, message: string) => invoke<void>("finish_export", { code, message }),
};

/** `nixe export <note> --format html|pdf` (cli.rs `ExportRequest`). */
export interface ExportRequest {
  /** Absolute path of the note. */
  note: string;
  /** Absolute vault root of the note. */
  vaultRoot: string;
  format: "html" | "pdf";
  /** Absolute path of the HTML file. */
  out: string | null;
  dark: boolean | null;
  pageSize: string | null;
  /** No window: the command waits for the file and the process ends with `finishExport`. */
  headless: boolean;
}

export const OPEN_FILE_EVENT = "open-file-requested";
/** A `nixe export` reached the running window; `takePendingExport` holds it. */
export const EXPORT_EVENT = "export-requested";
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
