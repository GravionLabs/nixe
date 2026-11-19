# Tauri commands

All commands are registered once in `lib.rs`'s `invoke_handler!` and given a typed
wrapper on the frontend in `src/app/core/file/backend.ts`, so nothing outside that file
calls `invoke()` directly.

| Command             | Rust signature                                   | Called from                    | Purpose |
| -------------------- | ------------------------------------------------- | ------------------------------- | ------- |
| `take_pending_file`  | `() -> Option<String>`                            | `AppComponent` (startup)        | Drains a path queued by CLI args / file association / second instance. |
| `read_text_file`     | `(path: String) -> Result<String, String>`        | `DocumentService.open/reload`   | Reads a file as UTF-8 (lossy). |
| `write_text_file`    | `(path: String, content: String) -> Result<(), String>` | `DocumentService.write` (editor) | Atomic write (temp file in the same folder, then rename). Only a note file below the vault root (set by `find_vault_root`) or in the folder of the open note (set by `watch_file`); refuses symlinks and notes over 5 MB. |
| `create_file`        | `(path: String) -> Result<(), String>`            | `VaultOpsService`               | Creates an empty file; never overwrites. Only below the vault root (symlinks resolved, `..` refused). |
| `create_dir`         | `(path: String) -> Result<(), String>`            | `VaultOpsService`               | Creates a folder and its missing parents below the vault root. |
| `rename_path`        | `(from: String, to: String) -> Result<Vec<Change>, String>` | `VaultOpsService.rename`       | Moves a file or folder inside the vault; refuses to replace, to move a folder into itself and any path outside the root. Rewrites the links to the moved files in the notes that refer to them (`vault/relink.rs`) and returns those notes. |
| `relink_preview`     | `(from: String, to: String) -> Result<Vec<Change>, String>` | `VaultOpsService.rename`       | The notes a rename would rewrite (`path`, `links`); changes nothing. Used for the confirmation of a folder rename. |
| `trash_path`         | `(path: String) -> Result<String, String>`        | `VaultOpsService.trash`         | Moves to `.trash/` at the vault root (Obsidian's default), numbering a taken name; returns the new path. |
| `new_note_location`  | `() -> Result<NewNoteLocation, String>`           | `VaultOpsService.newNoteFolder` | `newFileLocation` / `newFileFolderPath` of `.obsidian/app.json`; the vault root when missing. |
| `template_folder`    | `() -> Result<Option<String>, String>`            | `TemplateService.open`          | `folder` of `.obsidian/templates.json`; `None` when missing or empty (the setting `templateFolder` applies then). |
| `is_utf8_file`       | `(path: String) -> bool`                          | `EditorService.toggle`          | The editor refuses notes with invalid UTF-8 (`read_text_file` replaces those bytes). |
| `is_file`            | `(path: String) -> bool`                          | `ViewerComponent` (link resolve), `AppComponent` | Existence check for link targets. |
| `is_dir`             | `(path: String) -> bool`                          | `AppComponent.openPath`         | Decides file vs. folder when opening a dropped/CLI path. |
| `list_dir`           | `(path: String) -> Result<Vec<DirEntry>, String>` | `WorkspaceService.load`         | One folder level for the sidebar tree. |
| `find_wiki_root`     | `(path: String) -> String`                        | `DocumentService.open`          | Topmost `.order` ancestor, for `/absolute` links and images. |
| `watch_file`         | `(path: String) -> Result<(), String>`            | `DocumentService.open`          | (Re-)starts the live-reload watcher for the current file. |
| `git_vault_status`   | `() -> Result<Option<GitStatus>, String>`         | `GitService.refresh`            | Branch, changed/added/deleted files and ahead/behind of the vault's repository (`git.rs`, libgit2 behind the `GitBackend` trait); `None` when the vault root is not itself a Git repository, so the UI shows no Git. |
| `git_vault_commit`   | `(message: Option<String>, name: Option<String>, email: Option<String>) -> Result<String, String>` | `GitService.commit` | Stages all changes (including deletions) and commits; the message defaults to `vault backup: <timestamp>` (UTC). The author comes from the Git config, else from `name` and `email` (the settings). Refuses an empty commit. |
| `git_note_history`   | `(path: String, offset: usize, limit: usize) -> Result<Vec<HistoryEntry>, String>` | `HistoryService.load` | The commits that touched a vault-relative note, newest first, following renames (`git::note_history`; each entry has `id`, `author`, `time`, `message`, `path`, `parent`, `parentPath`). Pages by `offset`/`limit`; the walk restarts at HEAD, two tree lookups per commit. Empty for a vault without a repository. |
| `git_note_version`   | `(path: String, rev: Option<String>) -> Result<String, String>` | `HistoryService.compare` | The note at a commit (empty when it did not exist there), or the file on disk for `rev: None` (the uncommitted state). |
| `git_vault_sync`     | `(name: Option<String>, email: Option<String>) -> Result<SyncReport, String>` | `GitService.sync` | Commits open changes (default message), fetches `origin`, fast-forwards or rebases the local commits onto the remote branch and pushes (`gitsync::sync_vault`). A conflict never stops the sync: the remote text stays in `Note.md`, the local text is written as `Note (conflict <YYYY-MM-DD> <device>).md` next to it (binary files and delete-versus-edit conflicts too; a deleted side is restored from the common ancestor as the copy) and both are pushed. Returns `{committed, pulled, pushed, conflicts}`. Palette command `git-sync` (`Mod+Shift+S`) and the status-bar button run it. |
| `conflict_pair`      | `(path: String) -> Option<Pair>`                  | `ConflictService.refresh`       | The conflict pair `{original, copy}` a note belongs to; `null` for other notes. The sidebar marks both files, the note shows a bar that links them. |
| `resolve_conflict`   | `(path: String, keep: "this"\|"other") -> Result<String, String>` | `ConflictService.keep` | Replaces the original with the chosen text and moves the copy to `.trash/`; returns the original's path. |
| `git_token_status`   | `(host: String) -> Result<bool, String>` | `GitService.refreshToken` | Whether an HTTPS access token is stored for the remote host. The token itself is never returned. |
| `git_token_set`      | `(host: String, token: String) -> Result<(), String>` | `GitService.saveToken` | Stores or replaces the token in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service; crate `keyring`, service `dev.nixe.app.git`, one entry per host). Refuses an empty token. |
| `git_token_delete`   | `(host: String) -> Result<(), String>` | `GitService.deleteToken` | Removes the token of the host; succeeds when none is stored. |
| `git_clone_vault`    | `(url: String, parent: String) -> Result<String, String>` | `CloneService.start` | `File → Clone Vault…` (command `clone-vault`). Clones a `https://github.com/` url into `<parent>/<repository name>` (`gitclone::clone_vault`) and returns that folder, which the frontend opens as the vault. The folder must not exist yet. Uses the token of the keychain like sync (`auth-required:<host>` / `auth-failed:<host>` make the dialog show the token prompt of `GitService.runRemote`). Emits `git-clone-progress` (`{received, total}` objects, once per percent). A failed or cancelled clone removes the folder it created. |
| `git_clone_cancel`   | `() -> ()` | `CloneService.cancel` | Stops the running clone; `git_clone_vault` then fails with `cancelled`. |

A remote operation (`credentials.rs`, `gitsync::with_auth`) fails with `auth-required:<host>` when no token is stored (before it touches the network) and with `auth-failed:<host>` when the server rejects the token. `GitService.runRemote` catches both, asks for a token in the Git panel and runs the operation again. The token is never logged or shown, and never written to the vault or a settings file.

## Example: opening a file

```mermaid
sequenceDiagram
    participant Viewer as ViewerComponent
    participant Doc as DocumentService
    participant IPC as invoke()
    participant Rust as lib.rs

    Viewer->>Doc: open(path)
    par
        Doc->>IPC: read_text_file(path)
        IPC->>Rust: fs::read(path)
        Rust-->>Doc: file contents
    and
        Doc->>IPC: find_wiki_root(path)
        IPC->>Rust: walk ancestors for .order / .git
        Rust-->>Doc: wiki root path
    end
    Doc->>IPC: watch_file(path)
    IPC->>Rust: replace AppState.watcher
    Doc->>Doc: content.set(text), path.set(path), history push
```

`read_text_file` and `find_wiki_root` are fired with `Promise.all` — they're
independent, so there is no reason to serialize them.

## Error handling

Commands that can fail (`read_text_file`, `list_dir`, `watch_file`) return
`Result<T, String>`; Tauri turns the `Err` branch into a rejected Promise on the JS
side. `AppComponent.run()` is the single place that catches these and turns them into
the toast notification shown at the bottom of the window — there's no per-call
try/catch scattered through the services.

## Automatic sync

Off by default; settings (Git panel, stored in `nixe.settings`): `autoSync`, `autoSyncMinutes` (1–1440, default 10), `autoSyncOnFocus`, `autoSyncOnQuit`. `AutoSyncService` runs `GitService.sync({ auto: true })` through `AutoSyncScheduler` (`core/git/auto-sync.ts`): a request (interval tick, window focus) waits until there has been no keyboard or pointer input for 5 s, and never overlaps a running sync (requests that arrive meanwhile merge into one follow-up). On quit the window close is held until the sync has finished (at most 15 s). An automatic sync never asks for a token, and an error already shown is not shown again until a sync succeeds or the error changes.
