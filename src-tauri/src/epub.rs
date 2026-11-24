//! Reading an `.epub` book for the reader (#486): the WebView never opens the file itself. The
//! backend returns the bytes of a book that lies in a root of the open workspace or in the vault.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// Largest book that is returned. A book is 1 to 20 MB; this leaves room for an illustrated one.
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;

/// The bytes of the book `path`. The file must be a regular `.epub` file whose canonical path
/// (symlinks resolved, so a link cannot lead out) lies below one of `roots`.
pub fn read_epub(roots: &[PathBuf], path: &Path) -> Result<Vec<u8>, String> {
    let is_epub = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("epub"));
    if !is_epub {
        return Err(format!("not an EPUB file: {}", path.display()));
    }
    let real = dunce::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let inside = roots
        .iter()
        .filter_map(|r| dunce::canonicalize(r).ok())
        .any(|r| real.starts_with(r));
    if !inside {
        return Err(format!(
            "outside the open roots and the vault: {}",
            path.display()
        ));
    }
    let file = fs::File::open(&real).map_err(|e| format!("{}: {e}", path.display()))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    let too_large = || {
        format!(
            "book too large (limit {} MB): {}",
            MAX_BYTES / 1024 / 1024,
            path.display()
        )
    };
    if meta.len() > MAX_BYTES {
        return Err(too_large());
    }
    // The file may grow between the check and the read: never take more than the limit.
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-epub-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        dunce::canonicalize(p).unwrap()
    }

    #[test]
    fn returns_a_book_in_a_root() {
        let base = tmp("ok");
        fs::create_dir_all(base.join("root/books")).unwrap();
        fs::write(base.join("root/books/a.epub"), b"PK book").unwrap();
        let got = read_epub(&[base.join("root")], &base.join("root/books/a.epub")).unwrap();
        assert_eq!(got, b"PK book");
    }

    #[test]
    fn accepts_any_of_several_roots_and_an_upper_case_extension() {
        let base = tmp("several");
        fs::create_dir_all(base.join("a")).unwrap();
        fs::create_dir_all(base.join("b")).unwrap();
        fs::write(base.join("b/x.EPUB"), b"x").unwrap();
        let roots = [base.join("a"), base.join("b")];
        assert_eq!(read_epub(&roots, &base.join("b/x.EPUB")).unwrap(), b"x");
    }

    #[test]
    fn refuses_a_file_outside_every_root() {
        let base = tmp("outside");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::write(base.join("other.epub"), b"x").unwrap();
        let err = read_epub(&[base.join("root")], &base.join("other.epub")).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(read_epub(&[], &base.join("other.epub")).is_err());
    }

    #[test]
    fn refuses_dot_dot_out_of_a_root() {
        let base = tmp("dotdot");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::write(base.join("other.epub"), b"x").unwrap();
        let path = base.join("root/../other.epub");
        assert!(read_epub(&[base.join("root")], &path).is_err());
    }

    #[test]
    fn refuses_a_root_that_is_only_a_name_prefix() {
        let base = tmp("prefix");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::create_dir_all(base.join("root-evil")).unwrap();
        fs::write(base.join("root-evil/a.epub"), b"x").unwrap();
        assert!(read_epub(&[base.join("root")], &base.join("root-evil/a.epub")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_out_of_a_root() {
        let base = tmp("symlink");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::write(base.join("secret.epub"), b"secret").unwrap();
        std::os::unix::fs::symlink(base.join("secret.epub"), base.join("root/link.epub")).unwrap();
        let err = read_epub(&[base.join("root")], &base.join("root/link.epub")).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_folder_symlink_out_of_a_root() {
        let base = tmp("dirlink");
        fs::create_dir_all(base.join("root")).unwrap();
        fs::create_dir_all(base.join("away")).unwrap();
        fs::write(base.join("away/a.epub"), b"x").unwrap();
        std::os::unix::fs::symlink(base.join("away"), base.join("root/dir")).unwrap();
        assert!(read_epub(&[base.join("root")], &base.join("root/dir/a.epub")).is_err());
    }

    #[test]
    fn refuses_a_file_over_the_limit() {
        let base = tmp("big");
        fs::create_dir_all(base.join("root")).unwrap();
        let file = fs::File::create(base.join("root/big.epub")).unwrap();
        file.set_len(MAX_BYTES + 1).unwrap();
        let err = read_epub(&[base.join("root")], &base.join("root/big.epub")).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        // Exactly at the limit is still returned.
        let file = fs::File::create(base.join("root/edge.epub")).unwrap();
        file.set_len(MAX_BYTES).unwrap();
        let got = read_epub(&[base.join("root")], &base.join("root/edge.epub")).unwrap();
        assert_eq!(got.len() as u64, MAX_BYTES);
    }

    #[test]
    fn refuses_other_extensions_folders_and_missing_files() {
        let base = tmp("kinds");
        fs::create_dir_all(base.join("root/dir.epub")).unwrap();
        fs::write(base.join("root/a.txt"), b"x").unwrap();
        let roots = [base.join("root")];
        assert!(read_epub(&roots, &base.join("root/a.txt")).is_err());
        assert!(read_epub(&roots, &base.join("root/dir.epub")).is_err());
        assert!(read_epub(&roots, &base.join("root/missing.epub")).is_err());
    }
}
