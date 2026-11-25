# Rust tests: scratch directories

A test that needs a directory uses a guard that removes it when it drops, also when the test panics:

- Unit tests (`src-tauri/src/`): `crate::test_dir::TestDir::new("nixe-<area>-<name>-")` (`src/test_dir.rs`, test builds only). It derefs to `&Path` and its path is canonical.
- Integration tests (`src-tauri/tests/`): include the same file with `#[path = "../src/test_dir.rs"] mod test_dir;`, or use `tempfile::TempDir`.
- Bind the guard to a variable that lives as long as the path is used. `tmp("x").join("v")` drops the guard at the end of the statement, so the directory is gone (and a later `create_dir_all` recreates it as a leak). A helper that returns a path built from the guard returns the guard too.
- A test never builds `env::temp_dir().join(format!("...{}", std::process::id()))` by hand. With the process id in the name every `cargo test` run creates a new directory, and "remove it before create" only clears the same pid. In 2026-11 thousands of such directories filled the 1,048,576 inodes of a tmpfs `/tmp` (ENOSPC, the desktop froze).
- A fixed path is allowed only when the product reads it from a fixed place (`stdin_file_path()`); say so in a comment.

`pnpm check:temp-dirs` (`scripts/check-test-temp-dirs.mjs`, in the `frontend` CI job) fails for a tracked Rust file under `src-tauri` whose test code names `env::temp_dir()`, creates files, and has neither a guard (`TestDir`, `TempDir`, `tempdir(`, `tempfile::`) nor a `remove_dir_all` after use. It is a per-file heuristic: it does not replace the review of the guard's lifetime above. To check a run, set `TMPDIR` to an empty directory, run `cargo test` and list it.
