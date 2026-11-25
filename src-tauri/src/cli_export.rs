//! `nixe export <note> --format html|pdf`: the command line side of "Export as HTML / PDF".
//! The rendering (Markdown, Mermaid, KaTeX) lives in the app, so the command validates its
//! arguments and resolves the note here, then starts the app with an export request: the window
//! stays hidden, writes the HTML or PDF file and ends the process with the result, also next to a
//! running Nixe. A PDF without `--out` opens the print dialog of the note ("Save as PDF").
//!
//! `nixe export <folder> --format pdf --out <dir>` (#600) lists the notes of the folder here, and
//! the one hidden window prints them one after the other.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::Serialize;

use crate::cli::{note_path, CliError};
use crate::index::{self, scan};
use crate::site::{clean_exclude, published_text};
use crate::vault::resolve::is_markdown_path;
use crate::vault::walk_vault;

/// The export the process was started for; read once by `run` to start the app.
pub static REQUEST: OnceLock<ExportRequest> = OnceLock::new();

pub const PAGE_SIZES: &[&str] = &["A3", "A4", "A5", "Letter", "Legal"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    /// Absolute path of the note; of the folder for a folder export.
    pub note: String,
    /// Absolute path of the vault.
    pub vault_root: String,
    /// `html` or `pdf`.
    pub format: String,
    /// Absolute path of the file; of the target directory for a folder export; none for a PDF
    /// that goes to the print dialog.
    pub out: Option<String>,
    /// `--dark` / `--light`; none keeps the setting of the app.
    pub dark: Option<bool>,
    /// Normalised page size; none keeps the setting of the app.
    pub page_size: Option<String>,
    /// No window: the process writes the file and exits.
    pub headless: bool,
    /// The notes of a folder export (`<folder> --format pdf`); none for one note.
    pub notes: Option<Vec<FolderNote>>,
}

/// One note of a folder export and the PDF it becomes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNote {
    /// Absolute path of the note.
    pub note: String,
    /// Path relative to the exported folder, for the progress.
    pub name: String,
    /// Absolute path of the PDF.
    pub out: String,
}

#[derive(Debug, Default)]
pub struct Options {
    pub vaults: Vec<String>,
    pub workspace: Option<String>,
    pub positional: Vec<String>,
    pub format: Option<String>,
    pub out: Option<String>,
    pub dark: Option<bool>,
    pub page_size: Option<String>,
    /// `--include`: file name globs of a folder export.
    pub include: Vec<String>,
    /// `--exclude`: folders a folder export leaves out.
    pub exclude: Vec<String>,
}

/// True when the process of this request must not hand over to a running Nixe. A headless export
/// writes the file itself, so the command returns when the file exists and carries the result of
/// the export (#596, #599). A PDF without `--out` needs a window: the running one opens its print
/// dialog.
pub fn runs_alone(request: Option<&ExportRequest>) -> bool {
    request.is_some_and(|r| r.headless)
}

/// The page size named by `value`, in the spelling the app knows.
pub fn page_size(value: &str) -> Option<&'static str> {
    PAGE_SIZES
        .iter()
        .copied()
        .find(|s| s.eq_ignore_ascii_case(value.trim()))
}

/// Resolves the arguments of `nixe export` against the vault and the index.
pub fn resolve(
    opts: &Options,
    cwd: &Path,
    app_data: &Path,
    headless_allowed: bool,
) -> Result<ExportRequest, CliError> {
    let [note] = opts.positional.as_slice() else {
        return Err(CliError::Usage(
            "`export` takes one note or folder and --format html|pdf".into(),
        ));
    };
    let format = match opts.format.as_deref() {
        Some(f @ ("html" | "pdf")) => f,
        Some(other) => {
            return Err(CliError::Usage(format!(
                "--format is html or pdf, not {other}"
            )))
        }
        None => return Err(CliError::Usage("--format html|pdf is required".into())),
    };
    let page_size = match opts.page_size.as_deref() {
        Some(s) => Some(
            page_size(s)
                .ok_or_else(|| {
                    CliError::Usage(format!("--page-size is one of {}", PAGE_SIZES.join(", ")))
                })?
                .to_string(),
        ),
        None => None,
    };
    let dir = cwd.join(note);
    if format == "pdf" && dir.is_dir() {
        if let Some(out) = opts.out.as_deref() {
            if !headless_allowed {
                return Err(CliError::Failed(
                    "a folder is only exported from the command line".into(),
                ));
            }
            return resolve_folder(opts, cwd, app_data, &dir, out, page_size);
        }
    }
    if !opts.include.is_empty() || !opts.exclude.is_empty() {
        return Err(CliError::Usage(
            "--include and --exclude need a folder, --format pdf and --out <dir>".into(),
        ));
    }
    let roots = crate::cli::select_roots(&opts.vaults, opts.workspace.as_deref(), cwd, app_data)?;
    let [root] = roots.as_slice() else {
        return Err(CliError::Usage("`export` works on one vault".into()));
    };
    let root = PathBuf::from(&root.path);
    let mut conn = index::open(&index::index_path(app_data, &root))?;
    scan(&mut conn, &root, |_| {}).map_err(|e| CliError::Failed(format!("index: {e}")))?;
    let rel = note_path(&conn, note)?;
    let note_file = root.join(&rel);
    // HTML always goes to a file; a PDF only with `--out`, else to the print dialog.
    let out = (format == "html" || opts.out.is_some()).then(|| {
        let target = match &opts.out {
            Some(o) => cwd.join(o),
            None => cwd.join(
                Path::new(&rel)
                    .with_extension("html")
                    .file_name()
                    .unwrap_or_default(),
            ),
        };
        crate::path_to_string(&target)
    });
    let headless = headless_allowed && out.is_some();
    Ok(ExportRequest {
        note: crate::path_to_string(&note_file),
        vault_root: crate::path_to_string(&root),
        format: format.to_string(),
        out,
        dark: opts.dark,
        page_size,
        headless,
        notes: None,
    })
}

/// The request of `nixe export <folder> --format pdf --out <out>`: the notes of the folder that
/// the site export would publish and `--include` names, each with its PDF.
fn resolve_folder(
    opts: &Options,
    cwd: &Path,
    app_data: &Path,
    folder: &Path,
    out: &str,
    page_size: Option<String>,
) -> Result<ExportRequest, CliError> {
    let include = include_set(&opts.include)?;
    let folder = dunce::canonicalize(folder)
        .map_err(|e| CliError::Failed(format!("{}: {e}", folder.display())))?;
    let root = if opts.vaults.is_empty() && opts.workspace.is_none() {
        crate::vault::find_vault_root(&folder)
    } else {
        let roots =
            crate::cli::select_roots(&opts.vaults, opts.workspace.as_deref(), cwd, app_data)?;
        let [root] = roots.as_slice() else {
            return Err(CliError::Usage("`export` works on one vault".into()));
        };
        PathBuf::from(&root.path)
    };
    let folder_rel = folder
        .strip_prefix(&root)
        .map_err(|_| CliError::Failed(format!("{}: not inside the vault", folder.display())))?
        .to_string_lossy()
        .replace('\\', "/");
    let prefix = if folder_rel.is_empty() {
        folder_rel
    } else {
        format!("{folder_rel}/")
    };
    // `--out .` puts every PDF next to its note, wherever the command runs.
    let beside = Path::new(out) == Path::new(".");
    let target = cwd.join(out);
    let exclude = clean_exclude(&opts.exclude);
    let mut notes = Vec::new();
    for file in walk_vault(&root) {
        let path = file.path;
        let Some(name) = path.strip_prefix(&prefix) else {
            continue;
        };
        let file_name = name.rsplit('/').next().unwrap_or(name);
        if !is_markdown_path(&path) || include.as_ref().is_some_and(|i| !i.is_match(file_name)) {
            continue;
        }
        // A note that cannot be read stays in the list: the export reports it as failed.
        if matches!(published_text(&root, &path, &prefix, &exclude), Ok(None)) {
            continue;
        }
        let note = root.join(&path);
        let pdf = if beside {
            note.with_extension("pdf")
        } else {
            target.join(name).with_extension("pdf")
        };
        notes.push(FolderNote {
            note: crate::path_to_string(&note),
            name: name.to_string(),
            out: crate::path_to_string(&pdf),
        });
    }
    Ok(ExportRequest {
        note: crate::path_to_string(&folder),
        vault_root: crate::path_to_string(&root),
        format: "pdf".to_string(),
        out: Some(crate::path_to_string(&target)),
        dark: opts.dark,
        page_size,
        headless: true,
        notes: Some(notes),
    })
}

/// The file name globs of `--include`; none when there is no filter.
fn include_set(globs: &[String]) -> Result<Option<GlobSet>, CliError> {
    if globs.is_empty() {
        return Ok(None);
    }
    let usage = |e: globset::Error| CliError::Usage(format!("--include: {e}"));
    let mut set = GlobSetBuilder::new();
    for glob in globs {
        set.add(Glob::new(glob).map_err(usage)?);
    }
    set.build().map(Some).map_err(usage)
}

/// The line of stderr for the note `index` of `total` of a folder export.
pub fn progress_line(index: usize, total: usize, name: &str, error: Option<&str>) -> String {
    match error {
        Some(error) => format!("nixe: [{index}/{total}] {name}: failed: {error}"),
        None => format!("nixe: [{index}/{total}] {name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use std::fs;

    /// The vault and data folders; the first element is the guard of both.
    fn vault(name: &str) -> (TestDir, PathBuf, PathBuf) {
        let base = TestDir::new(&format!("nixe-export-{name}-"));
        let vault = base.join("vault");
        fs::create_dir_all(vault.join("sub")).unwrap();
        fs::write(vault.join("sub/Plan.md"), "# Plan\n").unwrap();
        fs::write(vault.join("A.md"), "a").unwrap();
        fs::create_dir_all(base.join("data")).unwrap();
        let data = base.join("data");
        (base, vault, data)
    }

    fn opts(format: Option<&str>, note: &str) -> Options {
        Options {
            format: format.map(str::to_string),
            positional: vec![note.to_string()],
            ..Options::default()
        }
    }

    #[test]
    fn html_goes_to_the_current_directory_and_runs_headless() {
        let (_base, vault, data) = vault("html");
        let mut o = opts(Some("html"), "Plan");
        o.vaults = vec![vault.to_string_lossy().into_owned()];
        o.dark = Some(true);
        o.page_size = Some("letter".into());
        let cwd = vault.parent().unwrap().to_path_buf();
        let r = resolve(&o, &cwd, &data, true).unwrap();
        assert!(r.note.ends_with("vault/sub/Plan.md"));
        assert_eq!(r.out, Some(crate::path_to_string(&cwd.join("Plan.html"))));
        assert_eq!(r.page_size.as_deref(), Some("Letter"));
        assert_eq!(r.dark, Some(true));
        assert!(r.headless);
        assert!(!resolve(&o, &cwd, &data, false).unwrap().headless);
    }

    #[test]
    fn an_export_into_a_file_does_not_go_to_a_running_instance() {
        let (_base, vault, data) = vault("running");
        let v = vec![vault.to_string_lossy().into_owned()];
        let mut html = opts(Some("html"), "A");
        html.vaults = v.clone();
        let mut file = opts(Some("pdf"), "A");
        file.vaults = v.clone();
        file.out = Some("a.pdf".into());
        let mut pdf = opts(Some("pdf"), "A");
        pdf.vaults = v;
        // The command line asks for headless; a running instance would end the process at once.
        let html = resolve(&html, &vault, &data, true).unwrap();
        let pdf = resolve(&pdf, &vault, &data, true).unwrap();
        assert!(runs_alone(Some(&html)));
        assert!(!runs_alone(Some(&pdf)));
        let file = resolve(&file, &vault, &data, true).unwrap();
        assert!(runs_alone(Some(&file)));
        // A normal start of the viewer is still forwarded.
        assert!(!runs_alone(None));
    }

    #[test]
    fn out_is_relative_to_the_current_directory() {
        let (_base, vault, data) = vault("out");
        let mut o = opts(Some("html"), "sub/Plan.md");
        o.vaults = vec![vault.to_string_lossy().into_owned()];
        o.out = Some("x/y.html".into());
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert_eq!(r.out, Some(crate::path_to_string(&vault.join("x/y.html"))));
    }

    #[test]
    fn a_pdf_without_out_has_no_file_and_opens_the_print_dialog() {
        let (_base, vault, data) = vault("pdf");
        let mut o = opts(Some("pdf"), "A");
        o.vaults = vec![vault.to_string_lossy().into_owned()];
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert_eq!(r.out, None);
        assert!(!r.headless);
    }

    #[test]
    fn a_pdf_with_out_is_written_without_a_window() {
        let (_base, vault, data) = vault("pdf-out");
        let mut o = opts(Some("pdf"), "A");
        o.vaults = vec![vault.to_string_lossy().into_owned()];
        o.out = Some("x/a.pdf".into());
        o.page_size = Some("a5".into());
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert_eq!(r.out, Some(crate::path_to_string(&vault.join("x/a.pdf"))));
        assert_eq!(r.format, "pdf");
        assert_eq!(r.page_size.as_deref(), Some("A5"));
        assert!(r.headless);
        assert!(!resolve(&o, &vault, &data, false).unwrap().headless);
    }

    #[test]
    fn wrong_arguments_are_usage_errors_and_a_missing_note_a_failure() {
        let (_base, vault, data) = vault("bad");
        let v = vec![vault.to_string_lossy().into_owned()];
        for o in [
            opts(None, "A"),
            opts(Some("docx"), "A"),
            Options {
                format: Some("html".into()),
                ..Options::default()
            },
            Options {
                page_size: Some("B7".into()),
                ..opts(Some("html"), "A")
            },
        ] {
            let o = Options {
                vaults: v.clone(),
                ..o
            };
            assert!(matches!(
                resolve(&o, &vault, &data, true),
                Err(CliError::Usage(_))
            ));
        }
        let o = Options {
            vaults: v,
            ..opts(Some("html"), "Missing")
        };
        assert!(matches!(
            resolve(&o, &vault, &data, true),
            Err(CliError::Failed(_))
        ));
    }

    /// A vault with notes in `docs/`, and the options of a folder export of it.
    fn folder(name: &str) -> (TestDir, PathBuf, PathBuf, Options) {
        let (base, vault, data) = vault(name);
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        for dir in ["docs/deep", "docs/old", "docs/empty"] {
            fs::create_dir_all(vault.join(dir)).unwrap();
        }
        for (file, text) in [
            ("docs/A – Zusammenfassung.md", "a"),
            ("docs/deep/B.markdown", "b"),
            (
                "docs/deep/C – Zusammenfassung.md",
                "---\npublish: true\n---\nc",
            ),
            ("docs/old/Old.md", "old"),
            ("docs/Draft.md", "\u{feff}---\npublish: false\n---\nx"),
            ("docs/No.md", "---\npublish: \"no\"\n---\nx"),
            ("docs/image.png", "x"),
        ] {
            fs::write(vault.join(file), text).unwrap();
        }
        let vault = dunce::canonicalize(&vault).unwrap();
        let mut o = opts(Some("pdf"), "docs");
        o.out = Some("../pdfs".into());
        (base, vault, data, o)
    }

    fn names(r: &ExportRequest) -> Vec<&str> {
        r.notes
            .as_ref()
            .unwrap()
            .iter()
            .map(|n| n.name.as_str())
            .collect()
    }

    #[test]
    fn a_folder_lists_one_pdf_per_published_note_below_out() {
        let (_base, vault, data, mut o) = folder("folder");
        o.page_size = Some("a5".into());
        o.dark = Some(false);
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert!(r.headless);
        assert!(runs_alone(Some(&r)));
        assert_eq!(r.vault_root, crate::path_to_string(&vault));
        assert_eq!(r.page_size.as_deref(), Some("A5"));
        assert_eq!(r.dark, Some(false));
        assert_eq!(
            names(&r),
            [
                "A – Zusammenfassung.md",
                "deep/B.markdown",
                "deep/C – Zusammenfassung.md",
                "old/Old.md"
            ]
        );
        let b = &r.notes.as_ref().unwrap()[1];
        assert_eq!(
            b.note,
            crate::path_to_string(&vault.join("docs/deep/B.markdown"))
        );
        assert_eq!(
            b.out,
            crate::path_to_string(&vault.join("../pdfs/deep/B.pdf"))
        );
    }

    #[test]
    fn out_dot_puts_each_pdf_next_to_its_note() {
        let (_base, vault, data, mut o) = folder("beside");
        for out in [".", "./"] {
            o.out = Some(out.into());
            let r = resolve(&o, &vault, &data, true).unwrap();
            assert_eq!(
                r.notes.unwrap()[1].out,
                crate::path_to_string(&vault.join("docs/deep/B.pdf"))
            );
        }
    }

    #[test]
    fn include_filters_by_file_name_and_exclude_skips_folders() {
        let (_base, vault, data, mut o) = folder("filter");
        o.include = vec!["* – Zusammenfassung.md".into()];
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert_eq!(
            names(&r),
            ["A – Zusammenfassung.md", "deep/C – Zusammenfassung.md"]
        );
        // Several globs add up; `--exclude` is relative to the folder or to the vault.
        o.include.push("O*".into());
        o.include.push("B.*".into());
        for exclude in ["deep", "docs/deep/"] {
            o.exclude = vec![exclude.into()];
            let r = resolve(&o, &vault, &data, true).unwrap();
            assert_eq!(names(&r), ["A – Zusammenfassung.md", "old/Old.md"]);
        }
        o.include = vec!["nothing".into()];
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert!(names(&r).is_empty());
    }

    #[test]
    fn a_folder_without_a_vault_option_and_the_vault_itself_are_exported() {
        let (_base, vault, data, mut o) = folder("root");
        o.positional = vec![".".into()];
        o.include = vec!["Plan.md".into()];
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert_eq!(r.vault_root, crate::path_to_string(&vault));
        assert_eq!(names(&r), ["sub/Plan.md"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_note_that_cannot_be_read_stays_in_the_list() {
        let (_base, vault, data, o) = folder("unreadable");
        fs::write(vault.join("docs/Bad.md"), [0xff, 0xfe, 0x00]).unwrap();
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert!(names(&r).contains(&"Bad.md"));
    }

    #[test]
    fn wrong_folder_exports_are_refused() {
        let (base, vault, data, o) = folder("refused");
        // A running window never prints a folder.
        assert!(resolve(&o, &vault, &data, false).is_err());
        // A folder outside the vault.
        fs::create_dir_all(base.join("elsewhere")).unwrap();
        let outside = Options {
            positional: vec![base.join("elsewhere").to_string_lossy().into_owned()],
            vaults: vec![vault.to_string_lossy().into_owned()],
            out: Some("x".into()),
            ..opts(Some("pdf"), "")
        };
        assert!(matches!(
            resolve(&outside, &vault, &data, true),
            Err(CliError::Failed(_))
        ));
        let bad_glob = Options {
            include: vec!["[".into()],
            out: Some("x".into()),
            ..opts(Some("pdf"), "docs")
        };
        // The filters belong to a folder export into PDFs only.
        let note = Options {
            include: vec!["*".into()],
            ..opts(Some("pdf"), "A")
        };
        let no_out = Options {
            exclude: vec!["deep".into()],
            ..opts(Some("pdf"), "docs")
        };
        let html = Options {
            exclude: vec!["deep".into()],
            ..opts(Some("html"), "docs")
        };
        for o in [bad_glob, note, no_out, html] {
            assert!(matches!(
                resolve(&o, &vault, &data, true),
                Err(CliError::Usage(_))
            ));
        }
    }

    #[test]
    fn the_command_line_hands_the_folder_filters_over() {
        let (_base, vault, data, _) = folder("args");
        let args = |list: &[&str]| list.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let r = crate::cli::parse_export(
            &args(&[
                "docs",
                "--format=pdf",
                "--out",
                "o",
                "--include",
                "*.md",
                "--include=B.*",
                "--exclude",
                "old",
                "--exclude=deep",
            ]),
            &vault,
            &data,
            true,
        )
        .unwrap();
        assert_eq!(names(&r), ["A – Zusammenfassung.md"]);
        let site = args(&["export", "docs", "--site", "o", "--include", "*"]);
        assert!(matches!(
            crate::cli::execute(&site, &vault, &data, &mut Vec::new()),
            Err(CliError::Usage(_))
        ));
    }

    #[test]
    fn progress_names_the_note_and_why_it_failed() {
        assert_eq!(progress_line(1, 3, "a/B.md", None), "nixe: [1/3] a/B.md");
        assert_eq!(
            progress_line(2, 3, "C.md", Some("disk full")),
            "nixe: [2/3] C.md: failed: disk full"
        );
    }
}
