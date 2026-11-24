//! A scratch directory for tests that is removed when the guard drops, also when the test panics.
//!
//! Tests must not build paths under `env::temp_dir()` by hand: a name with the process id differs on every
//! run, so a directory that is not removed piles up in `/tmp` (a tmpfs ran out of inodes this way).

use std::ops::Deref;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub(crate) struct TestDir {
    path: PathBuf,
    _guard: tempfile::TempDir,
}

impl TestDir {
    /// Creates `<temp>/<prefix>XXXXXX`. The path is canonical (no `\\?\` on Windows, no symlinked temp root).
    pub(crate) fn new(prefix: &str) -> Self {
        let guard = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
        let path = dunce::canonicalize(guard.path()).unwrap();
        Self {
            path,
            _guard: guard,
        }
    }
}

impl Deref for TestDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<Path> for TestDir {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_the_directory_on_drop() {
        let dir = TestDir::new("nixe-testdir-");
        let path = dir.to_path_buf();
        std::fs::write(path.join("f"), "x").unwrap();
        assert!(path.is_dir());
        drop(dir);
        assert!(!path.exists());
    }

    #[test]
    fn removes_the_directory_when_the_test_panics() {
        let seen = std::sync::Mutex::new(None);
        let result = std::panic::catch_unwind(|| {
            let dir = TestDir::new("nixe-testdir-");
            *seen.lock().unwrap() = Some(dir.to_path_buf());
            panic!("boom");
        });
        assert!(result.is_err());
        assert!(!seen.lock().unwrap().take().unwrap().exists());
    }
}
