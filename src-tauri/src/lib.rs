#[cfg(desktop)]
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager, State};

mod appearance;
mod attachments;
mod bookmarks;
#[cfg(desktop)]
mod capture;
#[cfg(desktop)]
mod capture_app;
/// Mobile has no global shortcut or capture window; the commands exist so the handler list is shared.
#[cfg(not(desktop))]
mod capture_app {
    const UNSUPPORTED: &str = "capture is not available on mobile";

    #[tauri::command]
    pub fn capture_save(_text: String) -> Result<String, String> {
        Err(UNSUPPORTED.into())
    }
    #[tauri::command]
    pub fn capture_note_names() -> Vec<String> {
        Vec::new()
    }
    #[tauri::command]
    pub fn capture_link_title(_url: String) -> Option<String> {
        None
    }
    #[tauri::command]
    pub fn capture_hide() {}
    #[tauri::command]
    pub fn capture_apply() -> Result<(), String> {
        Ok(())
    }
}
#[cfg(desktop)]
pub mod cli;
#[cfg(desktop)]
pub mod cli_export;
#[cfg(target_os = "macos")]
mod cli_install;
#[cfg(desktop)]
mod cli_write;
mod conflict;
mod credentials;
mod daily;
mod fileops;
mod folds;
mod git;
mod gitclone;
mod gitsync;
mod index;
#[cfg(desktop)]
pub mod mcp;
#[cfg(desktop)]
mod menu;
#[cfg(any(debug_assertions, mobile))]
mod notes;
mod review;
mod settings;
mod tree;
mod vault;
pub mod workspace;
mod write;

/// Event telling the frontend that a file or folder is waiting in `take_pending_file`.
const OPEN_FILE_EVENT: &str = "open-file-requested";
/// Event emitted when the watched file changed on disk (payload: path).
/// Event telling the frontend that a `nixe export` waits in `take_pending_export`.
const EXPORT_EVENT: &str = "export-requested";
const FILE_CHANGED_EVENT: &str = "file-changed";

#[derive(Default)]
struct AppState {
    /// File or folder requested via CLI argument, OS file association or a second instance.
    pending_file: Mutex<Option<String>>,
    /// Export requested by `nixe export`.
    pending_export: Mutex<Option<cli_export::ExportRequest>>,
    /// The process runs only for a `nixe export` to HTML: `finish_export` ends it.
    headless_export: std::sync::atomic::AtomicBool,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// Vault root last returned by `find_vault_root`; notes below it may be written.
    vault_root: Mutex<Option<PathBuf>>,
    /// Note last passed to `watch_file` (the open one); it and its siblings may be written.
    open_file: Mutex<Option<PathBuf>>,
    /// Set by `git_clone_cancel`; stops the running clone (#78).
    clone_cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// Paths are handed to the frontend with forward slashes on every platform.
fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// Where piped content (`nixe -`) is stored. The path is fixed because a second
/// instance only forwards its arguments, so the running one must be able to
/// find the file from the bare `-` argument.
fn stdin_file_path() -> PathBuf {
    std::env::temp_dir().join("nixe-stdin").join("stdin.md")
}

/// Smoke-test document shown on mobile, where there is no CLI or file association yet.
/// Writes `BUNDLED_FIXTURE` below `dir` and returns its path.
#[cfg(any(mobile, test))]
fn write_bundled_fixture(dir: &Path) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join("ios.md");
    std::fs::write(&path, include_str!("../../fixtures/ios.md"))?;
    Ok(path)
}

/// Reads piped Markdown into `stdin_file_path()`. Does nothing for a terminal stdin.
#[cfg(desktop)]
fn capture_stdin(args: &[String]) {
    if !args.iter().skip(1).any(|arg| arg == "-") || std::io::stdin().is_terminal() {
        return;
    }
    let mut content = Vec::new();
    if std::io::stdin().read_to_end(&mut content).is_err() {
        return;
    }
    let path = stdin_file_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, content);
}

/// First CLI argument (after the binary) that points to an existing file or folder.
/// `-` stands for the captured stdin content.
fn path_from_args(args: &[String], cwd: &Path) -> Option<String> {
    args.iter()
        .skip(1)
        .filter_map(|arg| match arg.as_str() {
            "-" => Some(stdin_file_path()),
            _ if arg.starts_with('-') => None,
            _ => dunce::canonicalize(cwd.join(arg)).ok(),
        })
        .find(|path| path.exists())
        .map(|path| path_to_string(&path))
}

fn queue_file(app: &AppHandle, path: String) {
    *app.state::<AppState>().pending_file.lock().unwrap() = Some(path);
    let _ = app.emit(OPEN_FILE_EVENT, ());
}

#[tauri::command]
fn take_pending_file(state: State<'_, AppState>) -> Option<String> {
    state.pending_file.lock().unwrap().take()
}

#[tauri::command]
fn take_pending_export(state: State<'_, AppState>) -> Option<cli_export::ExportRequest> {
    state.pending_export.lock().unwrap().take()
}

/// Ends a headless `nixe export`: the file path goes to stdout, an error to stderr.
#[tauri::command]
fn finish_export(state: State<'_, AppState>, code: i32, message: String) {
    if !state
        .headless_export
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    if code == 0 {
        println!("{message}");
    } else {
        eprintln!("nixe: {message}");
    }
    std::process::exit(code);
}

/// Writes an exported file where the user chose (save dialog or `--out`).
#[tauri::command]
fn write_export_file(path: String, content: String) -> Result<(), String> {
    write_export(Path::new(&path), content.as_bytes()).map_err(|e| format!("{path}: {e}"))
}

fn write_export(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, bytes)
}

/// The media type of an image or font by its extension.
fn media_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => return None,
    })
}

fn data_uri(path: &Path, bytes: &[u8]) -> Option<String> {
    use base64::Engine;
    let media = media_type(path)?;
    Some(format!(
        "data:{media};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// An image of a note as a `data:` URI, for the standalone HTML export. `None` for a file that
/// is missing or no image.
#[tauri::command]
fn read_data_uri(path: String) -> Option<String> {
    let path = Path::new(&path);
    data_uri(path, &std::fs::read(path).ok()?)
}

/// A file of the frontend bundle (the KaTeX fonts) as a `data:` URI. `None` in a dev build,
/// which serves the files from the dev server.
#[tauri::command]
fn read_bundled_data_uri(app: AppHandle, path: String) -> Option<String> {
    let asset = app.asset_resolver().get(path.clone())?;
    data_uri(Path::new(&path), &asset.bytes)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Atomically writes a note. The backend decides what may be written: a Markdown file below the
/// vault root, or one in the folder of the open note. The caller cannot name the root.
#[tauri::command]
fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let vault = state.vault_root.lock().unwrap().clone();
    let open = state.open_file.lock().unwrap().clone();
    let root = write::write_root(vault.as_deref(), open.as_deref(), Path::new(&path))?;
    write::write_text_file(&root, Path::new(&path), &content)
}

/// The vault root the file operations are confined to.
fn vault_root_of(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    state
        .vault_root
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no vault is open".to_string())
}

/// Git state of the vault; `None` when the vault is no Git repository.
#[tauri::command]
async fn git_vault_status(state: State<'_, AppState>) -> Result<Option<git::GitStatus>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::vault_status(&root))
        .await
        .map_err(|e| e.to_string())?
}

/// The commits that touched a note, newest first, following renames (#105).
#[tauri::command]
async fn git_note_history(
    state: State<'_, AppState>,
    path: String,
    offset: usize,
    limit: usize,
) -> Result<Vec<git::HistoryEntry>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::note_history(&root, &path, offset, limit))
        .await
        .map_err(|e| e.to_string())?
}

/// The notes that differ between a commit and HEAD (or `to`) (#107).
#[tauri::command]
async fn git_changes_between(
    state: State<'_, AppState>,
    from: String,
    to: Option<String>,
) -> Result<Vec<git::GitChange>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::changes_between(&root, &from, to.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// The newest commit at or before a time, in seconds since the epoch (#107).
#[tauri::command]
async fn git_rev_at(state: State<'_, AppState>, time: i64) -> Result<Option<String>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::rev_at(&root, time))
        .await
        .map_err(|e| e.to_string())?
}

/// The branches that wait for review (#108).
#[tauri::command]
async fn git_review_branches(
    state: State<'_, AppState>,
    prefix: String,
) -> Result<Vec<git::ReviewBranch>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::review_branches(&root, &prefix))
        .await
        .map_err(|e| e.to_string())?
}

/// The notes a branch changed against its merge base with HEAD (#108).
#[tauri::command]
async fn git_review_changes(
    state: State<'_, AppState>,
    rev: String,
) -> Result<git::ReviewChanges, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::review_changes(&root, &rev))
        .await
        .map_err(|e| e.to_string())?
}

/// The hunks of one note of a review branch (#109).
#[tauri::command]
async fn git_review_hunks(
    state: State<'_, AppState>,
    tip: String,
    path: String,
) -> Result<Vec<review::ReviewHunk>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || review::review_hunks(&root, &tip, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Commits the accepted changes of a review branch and optionally deletes the branch (#109).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn git_review_finish(
    state: State<'_, AppState>,
    branch: String,
    tip: String,
    decisions: Vec<review::NoteDecision>,
    delete_branch: bool,
    name: Option<String>,
    email: Option<String>,
) -> Result<review::ReviewOutcome, String> {
    let root = vault_root_of(&state)?;
    let fallback = match (name, email) {
        (Some(name), Some(email)) => Some(git::Identity { name, email }),
        _ => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        review::review_finish(
            &root,
            &branch,
            &tip,
            &decisions,
            delete_branch,
            fallback.as_ref(),
            &credentials::KeyringStore,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The unfinished decisions of a review branch, as saved (#109).
#[tauri::command]
fn git_review_state_load(
    state: State<'_, AppState>,
    branch: String,
) -> Result<Option<String>, String> {
    review::review_state_load(&vault_root_of(&state)?, &branch)
}

/// Saves (or, with `None`, removes) the unfinished decisions of a review branch (#109).
#[tauri::command]
fn git_review_state_save(
    state: State<'_, AppState>,
    branch: String,
    content: Option<String>,
) -> Result<(), String> {
    review::review_state_save(&vault_root_of(&state)?, &branch, content.as_deref())
}

/// The notes that the last commits deleted (#106).
#[tauri::command]
async fn git_deleted_notes(
    state: State<'_, AppState>,
    commits: usize,
) -> Result<Vec<git::DeletedNote>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::deleted_notes(&root, commits))
        .await
        .map_err(|e| e.to_string())?
}

/// A note at a commit, or the file on disk for `rev: None` (#105).
#[tauri::command]
async fn git_note_version(
    state: State<'_, AppState>,
    path: String,
    rev: Option<String>,
) -> Result<String, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::note_version(&root, &path, rev.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Stages every change of the vault and commits; returns the commit id.
/// The author comes from the Git config, else from `name` and `email` (the settings).
#[tauri::command]
async fn git_vault_commit(
    state: State<'_, AppState>,
    message: Option<String>,
    name: Option<String>,
    email: Option<String>,
) -> Result<String, String> {
    let root = vault_root_of(&state)?;
    let fallback = match (name, email) {
        (Some(name), Some(email)) => Some(git::Identity { name, email }),
        _ => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        git::vault_commit(&root, message.as_deref(), fallback.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sync: commits open changes, rebases onto the remote branch and pushes (#75).
/// A missing or rejected token gives `auth-required:<host>` / `auth-failed:<host>`.
#[tauri::command]
async fn git_vault_sync(
    state: State<'_, AppState>,
    name: Option<String>,
    email: Option<String>,
) -> Result<gitsync::SyncReport, String> {
    let root = vault_root_of(&state)?;
    let fallback = match (name, email) {
        (Some(name), Some(email)) => Some(git::Identity { name, email }),
        _ => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        gitsync::sync_vault(&root, fallback.as_ref(), &credentials::KeyringStore)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The conflict pair a note belongs to (as the original or the copy); `None` for other notes.
#[tauri::command]
fn conflict_pair(path: String) -> Option<conflict::Pair> {
    conflict::find_pair(Path::new(&path))
}

/// Keeps the text of this note or of the other half of its conflict pair: the original gets the
/// chosen text and the copy moves to `.trash/`. Returns the path of the original.
#[tauri::command]
fn resolve_conflict(
    state: State<'_, AppState>,
    path: String,
    keep: conflict::Keep,
) -> Result<String, String> {
    conflict::resolve(&vault_root_of(&state)?, Path::new(&path), keep).map(|p| path_to_string(&p))
}

/// Creates an empty file inside the vault; refuses to overwrite and paths outside the root.
#[tauri::command]
fn create_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    fileops::create_file(&vault_root_of(&state)?, Path::new(&path))
}

/// Creates a folder (and its missing parents) inside the vault.
#[tauri::command]
fn create_dir(state: State<'_, AppState>, path: String) -> Result<(), String> {
    fileops::create_dir(&vault_root_of(&state)?, Path::new(&path))
}

/// Renames or moves a file or folder inside the vault and rewrites the links to it in the notes
/// that contain them (one batch). Returns the notes that were rewritten. In a Git vault the
/// operation is one commit (#241).
#[tauri::command]
fn rename_path(
    state: State<'_, AppState>,
    index: State<'_, index::commands::IndexState>,
    from: String,
    to: String,
    name: Option<String>,
    email: Option<String>,
) -> Result<Vec<vault::relink::Change>, String> {
    let root = vault_root_of(&state)?;
    let fallback = identity_of(name, email);
    let (rel_from, rel_to) = (
        vault::ops::display(&root, Path::new(&from)),
        vault::ops::display(&root, Path::new(&to)),
    );
    let kind = vault::ops::rename_kind(&rel_from, &rel_to);
    vault::ops::commit_around(
        &root,
        kind,
        fallback.as_ref(),
        || {
            vault::relink::rename_with_links(&root, Path::new(&from), Path::new(&to), |targets| {
                index.referrers(targets)
            })
        },
        |changes| {
            (
                kind,
                format!(
                    "{kind}: {rel_from} -> {rel_to}{}",
                    vault::ops::links_suffix(changes.len())
                ),
            )
        },
    )
}

/// The Git author of the settings, when both parts are set.
fn identity_of(name: Option<String>, email: Option<String>) -> Option<git::Identity> {
    match (name, email) {
        (Some(name), Some(email)) => Some(git::Identity { name, email }),
        _ => None,
    }
}

/// The last vault operation that is not undone yet (#241); `None` without Git.
#[tauri::command]
async fn last_vault_operation(
    state: State<'_, AppState>,
) -> Result<Option<git::Operation>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || git::last_operation(&root))
        .await
        .map_err(|e| e.to_string())?
}

/// Reverts the last vault operation as a new commit; refused when it conflicts (#241).
#[tauri::command]
async fn undo_vault_operation(
    state: State<'_, AppState>,
    name: Option<String>,
    email: Option<String>,
) -> Result<git::Operation, String> {
    let root = vault_root_of(&state)?;
    let fallback = identity_of(name, email);
    tauri::async_runtime::spawn_blocking(move || git::undo_operation(&root, fallback.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

/// The notes whose links a rename of `from` to `to` would rewrite; changes nothing.
#[tauri::command]
fn relink_preview(
    state: State<'_, AppState>,
    index: State<'_, index::commands::IndexState>,
    from: String,
    to: String,
) -> Result<Vec<vault::relink::Change>, String> {
    Ok(vault::relink::preview(
        &vault_root_of(&state)?,
        Path::new(&from),
        Path::new(&to),
        |targets| index.referrers(targets),
    ))
}

/// The notes an extraction would change; changes nothing.
#[tauri::command]
fn extract_preview(
    state: State<'_, AppState>,
    index: State<'_, index::commands::IndexState>,
    source: String,
    target: String,
    what: vault::composer::What,
    embed: bool,
) -> Result<Vec<vault::composer::Change>, String> {
    vault::composer::preview_extract(
        &vault_root_of(&state)?,
        &source,
        &what,
        &target,
        embed,
        |t| index.referrers(t),
    )
}

/// Moves a selection or a section of `source` into the note `target` (created when missing) and
/// leaves a link or an embed. One batch for the watcher. Returns the notes that changed.
#[tauri::command]
fn extract_text(
    state: State<'_, AppState>,
    index: State<'_, index::commands::IndexState>,
    source: String,
    target: String,
    what: vault::composer::What,
    embed: bool,
    name: Option<String>,
    email: Option<String>,
) -> Result<Vec<vault::composer::Change>, String> {
    let root = vault_root_of(&state)?;
    let fallback = identity_of(name, email);
    let summary = format!(
        "extract: {} -> {}",
        vault::ops::display(&root, Path::new(&source)),
        vault::ops::display(&root, Path::new(&target))
    );
    vault::ops::commit_around(
        &root,
        "extraction",
        fallback.as_ref(),
        || {
            vault::composer::extract(&root, &source, &what, &target, embed, |t| {
                index.referrers(t)
            })
        },
        |changes| {
            (
                "extract",
                format!("{summary}, {} notes changed", changes.len()),
            )
        },
    )
}

/// The notes a merge of `source` into `target` would change; changes nothing.
#[tauri::command]
fn merge_preview(
    state: State<'_, AppState>,
    index: State<'_, index::commands::IndexState>,
    source: String,
    target: String,
) -> Result<Vec<vault::composer::Change>, String> {
    vault::composer::preview_merge(&vault_root_of(&state)?, &source, &target, |t| {
        index.referrers(t)
    })
}

/// Appends `source` to `target`, rewrites the links to it and moves it to `.trash/`.
#[tauri::command]
fn merge_note(
    state: State<'_, AppState>,
    index: State<'_, index::commands::IndexState>,
    source: String,
    target: String,
    name: Option<String>,
    email: Option<String>,
) -> Result<Vec<vault::composer::Change>, String> {
    let root = vault_root_of(&state)?;
    let fallback = identity_of(name, email);
    let (rel_source, rel_target) = (
        vault::ops::display(&root, Path::new(&source)),
        vault::ops::display(&root, Path::new(&target)),
    );
    vault::ops::commit_around(
        &root,
        "merge",
        fallback.as_ref(),
        || vault::composer::merge(&root, &source, &target, |t| index.referrers(t)),
        |changes| {
            (
                "merge",
                format!(
                    "merge: {rel_source} -> {rel_target}{}",
                    vault::ops::links_suffix(changes.len())
                ),
            )
        },
    )
}

/// Every replacement a find and replace would make, per note; changes nothing (#115).
#[tauri::command]
async fn replace_preview(
    state: State<'_, AppState>,
    options: vault::replace::Options,
) -> Result<Vec<vault::replace::NoteReplacements>, String> {
    let root = vault_root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || vault::replace::preview(&root, &options))
        .await
        .map_err(|e| e.to_string())?
}

/// Replaces in the vault as one batch. In a Git repository the open changes are committed first,
/// so that `git revert` undoes the replacement as a whole; a failing commit stops the batch.
#[tauri::command]
async fn replace_apply(
    state: State<'_, AppState>,
    options: vault::replace::Options,
    exclusions: vault::replace::Exclusions,
    name: Option<String>,
    email: Option<String>,
) -> Result<vault::replace::Applied, String> {
    let root = vault_root_of(&state)?;
    let fallback = match (name, email) {
        (Some(name), Some(email)) => Some(git::Identity { name, email }),
        _ => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        vault::replace::apply_with_checkpoint(&root, &options, &exclusions, fallback.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turns the plain-text mention of `target` at `line`/`start..end` of the note `source` (both
/// vault-relative) into a `[[link]]`. Refuses when the note changed since the mention was listed.
#[tauri::command]
fn link_mention(
    state: State<'_, AppState>,
    source: String,
    target: String,
    line: usize,
    start: usize,
    end: usize,
    text: String,
) -> Result<(), String> {
    let root = vault_root_of(&state)?;
    let path = root.join(&source);
    let content = std::fs::read_to_string(&path).map_err(|e| format!("{source}: {e}"))?;
    let title = target
        .rsplit('/')
        .next()
        .map(|n| n.rsplit_once('.').map_or(n, |(stem, _)| stem))
        .unwrap_or(&target);
    let linked = vault::mentions::link(&content, line, start, end, &text, title)
        .ok_or_else(|| format!("{source} changed, the mention is gone"))?;
    write::write_text_file(&root, &path, &linked)
}

/// Moves a file or folder to `.trash/` in the vault; returns its new path.
#[tauri::command]
fn trash_path(
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
    email: Option<String>,
) -> Result<String, String> {
    let root = vault_root_of(&state)?;
    let fallback = identity_of(name, email);
    let rel = vault::ops::display(&root, Path::new(&path));
    vault::ops::commit_around(
        &root,
        "delete",
        fallback.as_ref(),
        || fileops::trash_path(&root, Path::new(&path)).map(|p| path_to_string(&p)),
        |_| ("delete", format!("delete: {rel}")),
    )
}

/// Where a new note goes, from `.obsidian/app.json` of the vault.
#[tauri::command]
fn new_note_location(state: State<'_, AppState>) -> Result<fileops::NewNoteLocation, String> {
    Ok(fileops::new_note_location(&vault_root_of(&state)?))
}

/// The template folder from `.obsidian/templates.json` of the vault; `None` when it names none.
#[tauri::command]
fn template_folder(state: State<'_, AppState>) -> Result<Option<String>, String> {
    Ok(fileops::template_folder(&vault_root_of(&state)?))
}

/// The Daily notes settings from `.obsidian/daily-notes.json` of the vault.
#[tauri::command]
fn daily_notes_config(state: State<'_, AppState>) -> Result<fileops::DailyNotesConfig, String> {
    Ok(fileops::daily_notes_config(&vault_root_of(&state)?))
}

/// Saves pasted bytes as `name` in the attachment folder of `note`; returns the vault-relative path.
#[tauri::command]
fn save_attachment(
    state: State<'_, AppState>,
    note: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    attachments::save_bytes(&vault_root_of(&state)?, Path::new(&note), &name, &bytes)
}

/// Brings a dropped file into the vault (copied into the attachment folder of `note` unless it
/// already lies in the vault); returns the vault-relative path.
#[tauri::command]
fn import_attachment(
    state: State<'_, AppState>,
    note: String,
    source: String,
) -> Result<String, String> {
    attachments::import_file(
        &vault_root_of(&state)?,
        Path::new(&note),
        Path::new(&source),
    )
}

/// How links to notes are written, from `.obsidian/app.json` of the vault.
#[tauri::command]
fn link_format(state: State<'_, AppState>) -> Result<vault::relink::LinkFormat, String> {
    Ok(vault::relink::link_format(&vault_root_of(&state)?))
}

/// The app settings file of the app config directory; `None` when there is none yet.
#[tauri::command]
fn read_app_settings(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::read_settings(&dir)
}

/// Replaces the app settings file of the app config directory.
#[tauri::command]
fn write_app_settings(app: AppHandle, content: String) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    settings::write_settings(&dir, &content)
}

/// The `.css` files of `kind` (`themes` or `snippets`) in the app config directory (#114); creates the folders.
#[tauri::command]
fn read_appearance(app: AppHandle, kind: String) -> Result<Vec<appearance::CssFile>, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    appearance::ensure_folders(&dir)?;
    appearance::read_css(&dir, &kind)
}

/// The app config directory, where `themes/` and `snippets/` live.
#[tauri::command]
fn appearance_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// The fold state file of the app data directory; `None` when there is none yet.
#[tauri::command]
fn read_folds(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    folds::read_folds(&dir)
}

/// Replaces the fold state file of the app data directory.
#[tauri::command]
fn write_folds(app: AppHandle, content: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    folds::write_folds(&dir, &content)
}

/// `.obsidian/bookmarks.json` of the open vault; `None` when it has none.
#[tauri::command]
fn read_vault_bookmarks(state: State<'_, AppState>) -> Result<Option<String>, String> {
    bookmarks::read_vault(&vault_root_of(&state)?)
}

/// Replaces `.obsidian/bookmarks.json` of the open vault (it must have an `.obsidian` folder).
#[tauri::command]
fn write_vault_bookmarks(state: State<'_, AppState>, content: String) -> Result<(), String> {
    bookmarks::write_vault(&vault_root_of(&state)?, &content)
}

/// The bookmarks file of the app data directory; `None` when there is none yet.
#[tauri::command]
fn read_app_bookmarks(app: AppHandle) -> Result<Option<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    bookmarks::read_app(&dir)
}

/// Replaces the bookmarks file of the app data directory.
#[tauri::command]
fn write_app_bookmarks(app: AppHandle, content: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    bookmarks::write_app(&dir, &content)
}

/// Shows the user's shortcuts in the native menu: the accelerator per menu item id, `null` for none.
#[tauri::command]
fn set_menu_shortcuts(
    app: AppHandle,
    shortcuts: std::collections::HashMap<String, Option<String>>,
) -> usize {
    #[cfg(desktop)]
    return menu::apply_shortcuts(&app, &menu::clean_shortcuts(shortcuts));
    #[cfg(not(desktop))]
    {
        let _ = (app, shortcuts);
        0
    }
}

/// The Obsidian settings of the open vault, with the file each one comes from.
#[tauri::command]
fn obsidian_settings(state: State<'_, AppState>) -> Result<Vec<settings::ObsidianSetting>, String> {
    Ok(settings::obsidian_settings(&vault_root_of(&state)?))
}

/// False when the file holds bytes that are not UTF-8 (`read_text_file` would replace them).
#[tauri::command]
fn is_utf8_file(path: String) -> bool {
    std::fs::read(&path).is_ok_and(|bytes| std::str::from_utf8(&bytes).is_ok())
}

#[tauri::command]
fn is_file(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
fn is_dir(path: String) -> bool {
    Path::new(&path).is_dir()
}

/// Whether an entry exists at `path`, also one the file tree hides.
#[tauri::command]
fn path_exists(path: String) -> bool {
    fileops::entry_exists(Path::new(&path))
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<tree::DirEntry>, String> {
    tree::list_dir(Path::new(&path))
}

/// Root directory for wiki-absolute links ("/Page/Sub-Page").
///
/// Azure DevOps wikis keep a `.order` file in every folder, so the root is the
/// topmost directory of the contiguous `.order` chain. A `.git` directory stops
/// the search. Without any markers the file's own directory is used.
#[tauri::command]
fn find_wiki_root(path: String) -> String {
    let file_dir = Path::new(&path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let mut last_order_dir: Option<PathBuf> = None;

    for dir in file_dir.ancestors() {
        let has_order = dir.join(".order").is_file();
        if has_order {
            last_order_dir = Some(dir.to_path_buf());
        } else if last_order_dir.is_some() {
            break;
        }
        if dir.join(".git").exists() {
            return path_to_string(last_order_dir.as_deref().unwrap_or(dir));
        }
    }
    path_to_string(last_order_dir.as_deref().unwrap_or(&file_dir))
}

/// Vault root for an opened file or folder: the topmost ancestor containing `.obsidian/`,
/// else the opened folder. Read-only.
#[tauri::command]
fn find_vault_root(state: State<'_, AppState>, path: String) -> String {
    let root = vault::find_vault_root(Path::new(&path));
    *state.vault_root.lock().unwrap() = dunce::canonicalize(&root).ok();
    path_to_string(&root)
}

/// All files below the vault root (relative, forward slashes), see `vault::list_vault_files`.
#[tauri::command]
fn list_vault_files(root: String) -> Vec<String> {
    vault::list_vault_files(Path::new(&root))
}

/// The names of the saved workspaces (#116).
#[tauri::command]
fn workspace_list(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(workspace::list(&dir))
}

/// A saved workspace: its roots with their kinds.
#[tauri::command]
fn workspace_load(app: AppHandle, name: String) -> Result<workspace::Workspace, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    workspace::load(&dir, &name)
}

/// Saves a workspace in the app data directory; nothing is written into its folders.
#[tauri::command]
fn workspace_save(app: AppHandle, workspace: workspace::Workspace) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    workspace::save(&dir, &workspace)
}

/// Forgets a saved workspace; its folders stay.
#[tauri::command]
fn workspace_delete(app: AppHandle, name: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    workspace::delete(&dir, &name)
}

/// `workspace` with the folder at `path` added as a root (kind detected); changes nothing on disk.
#[tauri::command]
fn workspace_add_root(
    mut workspace: workspace::Workspace,
    path: String,
) -> Result<workspace::Workspace, String> {
    workspace.add_root(Path::new(&path))?;
    Ok(workspace)
}

/// Resolves link targets of a note in the root `from`; a `Root name:` prefix reaches another root.
/// One entry per target, `None` for a missing or ambiguous note.
#[tauri::command]
async fn workspace_resolve_links(
    workspace: workspace::Workspace,
    from: String,
    targets: Vec<String>,
) -> Result<Vec<Option<workspace::ResolvedLink>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let links = workspace::WorkspaceLinks::new(&workspace);
        targets.iter().map(|t| links.resolve(&from, t)).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Watches a single file. The parent directory is watched (non-recursively) so
/// that editors saving via "write temp file + rename" are detected as well.
#[tauri::command]
fn watch_file(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = target
        .parent()
        .ok_or("file has no parent directory")?
        .to_path_buf();
    let file_name = target.file_name().map(|n| n.to_os_string());

    let mut debouncer = new_debouncer(
        Duration::from_millis(250),
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if events
                    .iter()
                    .any(|e| e.path.file_name().map(|n| n.to_os_string()) == file_name)
                {
                    let _ = app.emit(FILE_CHANGED_EVENT, &path);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    *state.open_file.lock().unwrap() = dunce::canonicalize(&target).ok();

    // Replacing the old debouncer drops (and stops) the previous watch.
    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `nixe search …` and friends answer on the terminal and never start the window.
    #[cfg(desktop)]
    if let Some(code) = cli::try_run() {
        std::process::exit(code);
    }

    // Must happen before the single-instance plugin hands control to a running instance.
    #[cfg(desktop)]
    capture_stdin(&std::env::args().collect::<Vec<_>>());

    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        // Must be the first plugin: forwards files from a second launch.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if argv.get(1).is_some_and(|a| a == "export") {
                // A running window does the export; the new process ends at once.
                let request = cli::data_dir().and_then(|data| {
                    cli::parse_export(&argv[2..], Path::new(&cwd), &data, false)
                        .map_err(|e| eprintln!("nixe: export: {e:?}"))
                        .ok()
                });
                if let Some(request) = request {
                    *app.state::<AppState>().pending_export.lock().unwrap() = Some(request);
                    let _ = app.emit(EXPORT_EVENT, ());
                }
            } else if let Some(path) = path_from_args(&argv, Path::new(&cwd)) {
                queue_file(app, path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(index::commands::IndexState::default());

    // The updater checks only when the user asks (frontend `check()`); nothing runs at startup.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init())
            .plugin(tauri_plugin_clipboard_manager::init());
    }

    #[cfg(desktop)]
    {
        builder = builder.plugin(capture_app::plugin());
    }

    #[cfg(desktop)]
    {
        builder = builder.menu(menu::build).on_menu_event(|app, event| {
            #[cfg(target_os = "macos")]
            if event.id().as_ref() == menu::INSTALL_CLI_ID {
                return cli_install::run(app);
            }
            menu::forward_event(app, event.id().as_ref())
        });
    }

    let builder = builder.setup(|app| {
        let cwd = std::env::current_dir().unwrap_or_default();
        let args: Vec<String> = std::env::args().collect();
        #[cfg(desktop)]
        if let Some(request) = cli_export::REQUEST.get() {
            let state = app.state::<AppState>();
            state
                .headless_export
                .store(request.headless, std::sync::atomic::Ordering::SeqCst);
            *state.pending_export.lock().unwrap() = Some(request.clone());
            if request.headless {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        } else if let Some(path) = path_from_args(&args, &cwd) {
            *app.state::<AppState>().pending_file.lock().unwrap() = Some(path);
        }
        #[cfg(not(desktop))]
        if let Some(path) = path_from_args(&args, &cwd) {
            *app.state::<AppState>().pending_file.lock().unwrap() = Some(path);
        }
        // A shortcut that cannot be registered leaves capture off; the settings page shows why.
        #[cfg(desktop)]
        if let Err(e) = capture_app::apply(app.handle()) {
            eprintln!("capture: {e}");
        }
        #[cfg(mobile)]
        if app
            .state::<AppState>()
            .pending_file
            .lock()
            .unwrap()
            .is_none()
        {
            if let Ok(dir) = app.path().app_cache_dir() {
                if let Ok(path) = write_bundled_fixture(&dir) {
                    *app.state::<AppState>().pending_file.lock().unwrap() =
                        Some(path_to_string(&path));
                }
            }
        }
        Ok(())
    });

    // Spike commands (#58 to #60) are reachable only in debug and mobile builds.
    #[cfg(any(debug_assertions, mobile))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        take_pending_file,
        take_pending_export,
        finish_export,
        write_export_file,
        read_data_uri,
        read_bundled_data_uri,
        read_text_file,
        write_text_file,
        create_file,
        create_dir,
        rename_path,
        relink_preview,
        extract_preview,
        extract_text,
        merge_preview,
        merge_note,
        last_vault_operation,
        undo_vault_operation,
        replace_preview,
        replace_apply,
        trash_path,
        conflict_pair,
        resolve_conflict,
        new_note_location,
        template_folder,
        daily_notes_config,
        link_format,
        read_app_settings,
        write_app_settings,
        read_appearance,
        appearance_dir,
        workspace_list,
        workspace_load,
        workspace_save,
        workspace_delete,
        workspace_add_root,
        workspace_resolve_links,
        read_folds,
        write_folds,
        read_vault_bookmarks,
        write_vault_bookmarks,
        read_app_bookmarks,
        write_app_bookmarks,
        set_menu_shortcuts,
        obsidian_settings,
        save_attachment,
        import_attachment,
        is_utf8_file,
        is_file,
        is_dir,
        path_exists,
        list_dir,
        find_wiki_root,
        find_vault_root,
        list_vault_files,
        index::commands::index_start,
        index::commands::index_status,
        index::commands::notes,
        index::commands::note_meta,
        index::commands::backlinks,
        index::commands::related_notes,
        index::commands::unlinked_mentions,
        link_mention,
        index::commands::tags,
        index::commands::search_notes,
        index::commands::workspace_index,
        index::commands::search_workspace,
        index::commands::workspace_notes,
        index::commands::vault_health,
        watch_file,
        git_vault_status,
        git_vault_commit,
        git_note_history,
        git_note_version,
        git_deleted_notes,
        git_changes_between,
        git_rev_at,
        git_review_branches,
        git_review_changes,
        git_review_hunks,
        git_review_finish,
        git_review_state_load,
        git_review_state_save,
        git_vault_sync,
        credentials::git_token_status,
        credentials::git_token_set,
        credentials::git_token_delete,
        gitclone::git_clone_vault,
        gitclone::git_clone_cancel,
        capture_app::capture_save,
        capture_app::capture_note_names,
        capture_app::capture_link_title,
        capture_app::capture_hide,
        capture_app::capture_apply,
        gitsync::git_clone,
        gitsync::git_spike_edit,
        gitsync::git_commit,
        gitsync::git_pull_rebase,
        gitsync::git_push,
        notes::notes_list,
        notes::notes_read,
        notes::notes_write,
        notes::spike_external_path,
        notes::spike_external_read,
        notes::spike_external_write
    ]);
    #[cfg(not(any(debug_assertions, mobile)))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        take_pending_file,
        take_pending_export,
        finish_export,
        write_export_file,
        read_data_uri,
        read_bundled_data_uri,
        read_text_file,
        write_text_file,
        create_file,
        create_dir,
        rename_path,
        relink_preview,
        extract_preview,
        extract_text,
        merge_preview,
        merge_note,
        last_vault_operation,
        undo_vault_operation,
        replace_preview,
        replace_apply,
        trash_path,
        conflict_pair,
        resolve_conflict,
        new_note_location,
        template_folder,
        daily_notes_config,
        link_format,
        read_app_settings,
        write_app_settings,
        read_appearance,
        appearance_dir,
        workspace_list,
        workspace_load,
        workspace_save,
        workspace_delete,
        workspace_add_root,
        workspace_resolve_links,
        read_folds,
        write_folds,
        read_vault_bookmarks,
        write_vault_bookmarks,
        read_app_bookmarks,
        write_app_bookmarks,
        set_menu_shortcuts,
        obsidian_settings,
        save_attachment,
        import_attachment,
        is_utf8_file,
        is_file,
        is_dir,
        path_exists,
        list_dir,
        find_wiki_root,
        find_vault_root,
        list_vault_files,
        index::commands::index_start,
        index::commands::index_status,
        index::commands::notes,
        index::commands::note_meta,
        index::commands::backlinks,
        index::commands::related_notes,
        index::commands::unlinked_mentions,
        link_mention,
        index::commands::tags,
        index::commands::search_notes,
        index::commands::workspace_index,
        index::commands::search_workspace,
        index::commands::workspace_notes,
        index::commands::vault_health,
        watch_file,
        git_vault_status,
        git_vault_commit,
        git_note_history,
        git_note_version,
        git_deleted_notes,
        git_changes_between,
        git_rev_at,
        git_review_branches,
        git_review_changes,
        git_review_hunks,
        git_review_finish,
        git_review_state_load,
        git_review_state_save,
        git_vault_sync,
        credentials::git_token_status,
        credentials::git_token_set,
        credentials::git_token_delete,
        gitclone::git_clone_vault,
        gitclone::git_clone_cancel,
        capture_app::capture_save,
        capture_app::capture_note_names,
        capture_app::capture_link_title,
        capture_app::capture_hide,
        capture_app::capture_apply
    ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building nixe");

    app.run(|_app, _event| {
        // macOS delivers files opened via Finder / file association as an event.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            if let Some(path) = urls.iter().find_map(|url| url.to_file_path().ok()) {
                queue_file(_app, path_to_string(&path));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nixe-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    #[test]
    fn wiki_root_is_topmost_order_dir() {
        let root = temp_dir("order");
        let sub = root.join("wiki").join("Architektur");
        fs::create_dir_all(&sub).unwrap();
        fs::write(root.join("wiki/.order"), "").unwrap();
        fs::write(sub.join(".order"), "").unwrap();
        let file = sub.join("Overview.md");
        assert_eq!(
            find_wiki_root(path_to_string(&file)),
            path_to_string(&root.join("wiki"))
        );
    }

    #[test]
    fn wiki_root_stops_at_git_dir() {
        let root = temp_dir("git");
        let sub = root.join("docs");
        fs::create_dir_all(sub.join("deep")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        let file = sub.join("deep/a.md");
        assert_eq!(find_wiki_root(path_to_string(&file)), path_to_string(&root));
    }

    #[test]
    fn cli_args_resolve_relative_files() {
        let root = temp_dir("args");
        fs::write(root.join("README.md"), "# hi").unwrap();
        let args = vec![
            "nixe".into(),
            "--verbose".into(),
            "missing.md".into(),
            "README.md".into(),
        ];
        assert_eq!(
            path_from_args(&args, &root),
            Some(path_to_string(&root.join("README.md")))
        );
        let args = vec!["nixe".into(), ".".into()];
        assert_eq!(path_from_args(&args, &root), Some(path_to_string(&root)));
    }

    #[test]
    fn export_files_are_written_below_new_folders() {
        let dir = temp_dir("export");
        let file = dir.join("out/deep/note.html");
        write_export(&file, b"<p>x</p>").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "<p>x</p>");
        write_export(&file, b"y").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "y");
    }

    #[test]
    fn images_become_data_uris_and_other_files_do_not() {
        assert_eq!(
            data_uri(Path::new("a/B.PNG"), b"hi").as_deref(),
            Some("data:image/png;base64,aGk=")
        );
        assert!(data_uri(Path::new("notes.md"), b"hi").is_none());
        assert!(read_data_uri("/definitely/missing.png".into()).is_none());
    }

    #[test]
    fn dash_argument_resolves_to_captured_stdin() {
        let args = vec!["nixe".into(), "-".into()];
        let expected = stdin_file_path();
        fs::create_dir_all(expected.parent().unwrap()).unwrap();
        fs::write(&expected, "# piped").unwrap();
        assert_eq!(
            path_from_args(&args, Path::new("/")),
            Some(path_to_string(&expected))
        );
    }

    #[test]
    fn bundled_fixture_contains_mermaid_and_math() {
        let dir = temp_dir("fixture").join("cache");
        let path = write_bundled_fixture(&dir).unwrap();
        let text = fs::read_to_string(path).unwrap();
        assert!(text.contains("```mermaid"));
        assert!(text.contains("$$"));
    }
}
