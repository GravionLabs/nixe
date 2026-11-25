//! `nixe export <note> --format html|pdf`: the command line side of "Export as HTML / PDF".
//! The rendering (Markdown, Mermaid, KaTeX) lives in the app, so the command validates its
//! arguments and resolves the note here, then starts the app with an export request: the window
//! stays hidden, writes the HTML file and ends the process with the result, also next to a
//! running Nixe. A PDF has no
//! silent path in the system web views; the request opens the print dialog of the note ("Save as
//! PDF").

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

use crate::cli::{note_path, CliError};
use crate::index::{self, scan};

/// The export the process was started for; read once by `run` to start the app.
pub static REQUEST: OnceLock<ExportRequest> = OnceLock::new();

pub const PAGE_SIZES: &[&str] = &["A3", "A4", "A5", "Letter", "Legal"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    /// Absolute path of the note.
    pub note: String,
    /// Absolute path of the vault.
    pub vault_root: String,
    /// `html` or `pdf`.
    pub format: String,
    /// Absolute path of the HTML file; none for a PDF.
    pub out: Option<String>,
    /// `--dark` / `--light`; none keeps the setting of the app.
    pub dark: Option<bool>,
    /// Normalised page size; none keeps the setting of the app.
    pub page_size: Option<String>,
    /// No window: the process writes the file and exits.
    pub headless: bool,
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
}

/// True when the process of this request must not hand over to a running Nixe. A headless export
/// writes the file itself, so the command returns when the file exists and carries the result of
/// the export (#596). A PDF needs a window: the running one opens its print dialog.
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
            "`export` takes one note and --format html|pdf".into(),
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
    if format == "pdf" && opts.out.is_some() {
        return Err(CliError::Usage(
            "--out is for html; a PDF is saved from the print dialog".into(),
        ));
    }
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
    let roots = crate::cli::select_roots(&opts.vaults, opts.workspace.as_deref(), cwd, app_data)?;
    let [root] = roots.as_slice() else {
        return Err(CliError::Usage("`export` works on one vault".into()));
    };
    let root = PathBuf::from(&root.path);
    let mut conn = index::open(&index::index_path(app_data, &root))?;
    scan(&mut conn, &root, |_| {}).map_err(|e| CliError::Failed(format!("index: {e}")))?;
    let rel = note_path(&conn, note)?;
    let note_file = root.join(&rel);
    let out = (format == "html").then(|| {
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
    Ok(ExportRequest {
        note: crate::path_to_string(&note_file),
        vault_root: crate::path_to_string(&root),
        format: format.to_string(),
        out,
        dark: opts.dark,
        page_size,
        headless: headless_allowed && format == "html",
    })
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
    fn an_html_export_does_not_go_to_a_running_instance() {
        let (_base, vault, data) = vault("running");
        let v = vec![vault.to_string_lossy().into_owned()];
        let mut html = opts(Some("html"), "A");
        html.vaults = v.clone();
        let mut pdf = opts(Some("pdf"), "A");
        pdf.vaults = v;
        // The command line asks for headless; a running instance would end the process at once.
        let html = resolve(&html, &vault, &data, true).unwrap();
        let pdf = resolve(&pdf, &vault, &data, true).unwrap();
        assert!(runs_alone(Some(&html)));
        assert!(!runs_alone(Some(&pdf)));
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
    fn pdf_has_no_file_and_opens_the_print_dialog() {
        let (_base, vault, data) = vault("pdf");
        let mut o = opts(Some("pdf"), "A");
        o.vaults = vec![vault.to_string_lossy().into_owned()];
        let r = resolve(&o, &vault, &data, true).unwrap();
        assert_eq!(r.out, None);
        assert!(!r.headless);
        o.out = Some("a.pdf".into());
        assert!(matches!(
            resolve(&o, &vault, &data, true),
            Err(CliError::Usage(_))
        ));
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
}
