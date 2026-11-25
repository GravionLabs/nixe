//! The silent PDF of `nixe export --format pdf --out <file>` (#599): the hidden export window
//! holds the finished document and the web view of the platform prints it into a file. No dialog,
//! no header or footer. What each web view honours of `@page` is recorded in `docs/export.md`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

/// The margin of the printed page in mm; `PAGE_MARGIN_MM` of `export-core.ts`.
pub const MARGIN_MM: f64 = 18.0;
/// A web view that never answers must not leave the command hanging.
const PRINT_TIMEOUT: Duration = Duration::from_secs(120);

/// The portrait paper of a page size; the web views take it besides the `@page` rule.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Paper {
    pub width_mm: f64,
    pub height_mm: f64,
}

/// The paper of a page size in the spelling of `cli_export::PAGE_SIZES`.
pub fn paper(page_size: &str) -> Option<Paper> {
    let (width_mm, height_mm) = match page_size {
        "A3" => (297.0, 420.0),
        "A4" => (210.0, 297.0),
        "A5" => (148.0, 210.0),
        "Letter" => (215.9, 279.4),
        "Legal" => (215.9, 355.6),
        _ => return None,
    };
    Some(Paper {
        width_mm,
        height_mm,
    })
}

/// Where the platform writes; the target is only replaced by a complete PDF.
fn part_path(target: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(".");
    name.push(target.file_name().unwrap_or_default());
    name.push(format!(".{}.part.pdf", std::process::id()));
    target.with_file_name(name)
}

/// Runs `print` on a file beside `target` and moves a complete PDF into place. A failed print
/// leaves `target` as it was.
pub fn write_pdf(
    target: &Path,
    print: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if target.is_dir() {
        return Err("is a folder".into());
    }
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let part = part_path(target);
    // The platform may only report that it failed: find an unwritable folder here, with a reason.
    fs::File::create(&part).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&part);
    let result = print(&part).and_then(|()| {
        let mut head = [0u8; 5];
        fs::File::open(&part)
            .and_then(|mut f| f.read_exact(&mut head))
            .map_err(|e| format!("no PDF was written: {e}"))?;
        if &head != b"%PDF-" {
            return Err("the web view did not write a PDF".into());
        }
        fs::rename(&part, target).map_err(|e| e.to_string())
    });
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

/// Prints the document of `window` into `target`. Blocks until the web view is done, so it must
/// not run on the main thread.
pub fn print_window(
    window: &tauri::WebviewWindow,
    target: &Path,
    page_size: &str,
) -> Result<(), String> {
    let paper = paper(page_size).ok_or_else(|| format!("unknown page size {page_size}"))?;
    // SPIKE (temporary): a native paper and margin that differ from `@page`.
    let paper = if std::env::var_os("NIXE_PDF_SPIKE").is_some() {
        Paper {
            width_mm: 215.9,
            height_mm: 355.6,
        }
    } else {
        paper
    };
    write_pdf(target, |file| {
        let (tx, rx) = mpsc::channel();
        let file = file.to_path_buf();
        window
            .with_webview(move |webview| platform::print(webview, &file, paper, tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(PRINT_TIMEOUT)
            .map_err(|_| "the print did not finish".to_string())?
    })
}

/// SPIKE (temporary).
fn margin() -> f64 {
    if std::env::var_os("NIXE_PDF_SPIKE").is_some() {
        40.0
    } else {
        MARGIN_MM
    }
}

type Reply = mpsc::Sender<Result<(), String>>;

/// WebKitGTK: a print operation whose settings name a file.
#[cfg(target_os = "linux")]
mod platform {
    use std::path::Path;

    use gtk::prelude::ObjectExt;
    use gtk::{PageSetup, PaperSize, PrintSettings, Unit};
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    use super::{margin as spike_margin, Paper, Reply};

    /// Runs on the main thread; the answer comes through `reply` when WebKit is done.
    pub fn print(
        webview: tauri::webview::PlatformWebview,
        file: &Path,
        paper: Paper,
        reply: Reply,
    ) {
        let uri = match gtk::glib::filename_to_uri(file, None) {
            Ok(uri) => uri,
            Err(e) => {
                let _ = reply.send(Err(e.to_string()));
                return;
            }
        };
        // Without a printer WebKit takes the default printer of the system: paper instead of a
        // file. This process only writes files, so GTK loads no other backend than that one.
        let Some(gtk_settings) = gtk::Settings::default() else {
            let _ = reply.send(Err("GTK has no display".into()));
            return;
        };
        gtk_settings.set_property("gtk-print-backends", "file");
        let size = PaperSize::new_custom("nixe", "nixe", paper.width_mm, paper.height_mm, Unit::Mm);
        let setup = PageSetup::new();
        setup.set_paper_size(&size);
        setup.set_top_margin(spike_margin(), Unit::Mm);
        setup.set_bottom_margin(spike_margin(), Unit::Mm);
        setup.set_left_margin(spike_margin(), Unit::Mm);
        setup.set_right_margin(spike_margin(), Unit::Mm);
        let settings = PrintSettings::new();
        // The name of the printer of the file backend is translated by GTK.
        settings.set_printer(&gtk::glib::dgettext(Some("gtk30"), "Print to File"));
        settings.set("output-uri", Some(&uri));
        settings.set("output-file-format", Some("pdf"));
        settings.set_paper_size(&size);
        let operation = PrintOperation::new(&webview.inner());
        operation.set_print_settings(&settings);
        operation.set_page_setup(&setup);
        // `failed` comes before `finished`: the first answer counts.
        let failed = reply.clone();
        operation.connect_failed(move |_, e| {
            let _ = failed.send(Err(e.to_string()));
        });
        operation.connect_finished(move |_| {
            let _ = reply.send(Ok(()));
        });
        operation.print();
    }
}

/// WebView2: `PrintToPdf` with its own print settings.
#[cfg(windows)]
mod platform {
    use std::path::Path;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    use super::{margin as spike_margin, Paper, Reply};

    const MM_PER_INCH: f64 = 25.4;

    /// Runs on the main thread; the answer comes through `reply` when WebView2 is done.
    pub fn print(
        webview: tauri::webview::PlatformWebview,
        file: &Path,
        paper: Paper,
        reply: Reply,
    ) {
        // WebView2 wants a path with backslashes.
        let file = HSTRING::from(file.to_string_lossy().replace('/', "\\"));
        let done = reply.clone();
        let started = (|| -> windows_core::Result<()> {
            // SAFETY: COM calls on the main thread, on the objects of the live web view.
            unsafe {
                let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
                let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
                let settings = environment.CreatePrintSettings()?;
                settings.SetPageWidth(paper.width_mm / MM_PER_INCH)?;
                settings.SetPageHeight(paper.height_mm / MM_PER_INCH)?;
                settings.SetMarginTop(spike_margin() / MM_PER_INCH)?;
                settings.SetMarginBottom(spike_margin() / MM_PER_INCH)?;
                settings.SetMarginLeft(spike_margin() / MM_PER_INCH)?;
                settings.SetMarginRight(spike_margin() / MM_PER_INCH)?;
                settings.SetShouldPrintBackgrounds(true)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
                let handler = PrintToPdfCompletedHandler::create(Box::new(
                    move |result: windows_core::Result<()>, ok: bool| {
                        let _ = done.send(match result {
                            Err(e) => Err(e.to_string()),
                            Ok(()) if !ok => Err("WebView2 could not write the PDF".into()),
                            Ok(()) => Ok(()),
                        });
                        Ok(())
                    },
                ));
                core.PrintToPdf(&file, &settings, &handler)
            }
        })();
        if let Err(e) = started {
            let _ = reply.send(Err(e.to_string()));
        }
    }
}

/// WKWebView: a print operation that saves to a file, without panels.
#[cfg(target_os = "macos")]
mod platform {
    use std::cell::Cell;
    use std::ffi::c_void;
    use std::path::Path;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSPrintHeaderAndFooter, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob,
        NSPrintingPaginationMode, NSWindow,
    };
    use objc2_foundation::{
        NSCopying, NSNumber, NSObject, NSObjectProtocol, NSSize, NSString, NSURL,
    };
    use objc2_web_kit::WKWebView;

    use super::{margin as spike_margin, Paper, Reply};

    const POINTS_PER_MM: f64 = 72.0 / 25.4;

    struct Ivars {
        reply: Cell<Option<Reply>>,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements and the class does not implement Drop.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "NixePdfPrintDelegate"]
        #[ivars = Ivars]
        struct PrintDelegate;

        impl PrintDelegate {
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn did_run(&self, _operation: &NSPrintOperation, success: Bool, _info: *mut c_void) {
                if let Some(reply) = self.ivars().reply.take() {
                    let _ = reply.send(if success.as_bool() {
                        Ok(())
                    } else {
                        Err("WKWebView could not write the PDF".into())
                    });
                }
            }
        }
    );

    /// Runs on the main thread; the answer comes through `reply` when the operation ran.
    pub fn print(
        webview: tauri::webview::PlatformWebview,
        file: &Path,
        paper: Paper,
        reply: Reply,
    ) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = reply.send(Err("not on the main thread".into()));
            return;
        };
        // SAFETY: the pointers are the WKWebView and the NSWindow of the live web view, used on
        // the main thread.
        unsafe {
            let view: &WKWebView = &*webview.inner().cast();
            let window: &NSWindow = &*webview.ns_window().cast();
            if !view.respondsToSelector(sel!(printOperationWithPrintInfo:)) {
                let _ = reply.send(Err("a silent PDF needs macOS 11 or later".into()));
                return;
            }
            let info = NSPrintInfo::sharedPrintInfo().copy();
            info.setPaperSize(NSSize::new(
                paper.width_mm * POINTS_PER_MM,
                paper.height_mm * POINTS_PER_MM,
            ));
            let margin = spike_margin() * POINTS_PER_MM;
            info.setTopMargin(margin);
            info.setBottomMargin(margin);
            info.setLeftMargin(margin);
            info.setRightMargin(margin);
            info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
            info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
            info.setHorizontallyCentered(false);
            info.setVerticallyCentered(false);
            info.setJobDisposition(NSPrintSaveJob);
            let url = NSURL::fileURLWithPath(&NSString::from_str(&file.to_string_lossy()));
            let attributes: Retained<AnyObject> = msg_send![&*info, dictionary];
            let _: () = msg_send![&*attributes, setObject: &*url, forKey: NSPrintJobSavingURL];
            let no = NSNumber::numberWithBool(false);
            let _: () = msg_send![&*attributes, setObject: &*no, forKey: NSPrintHeaderAndFooter];

            let operation = view.printOperationWithPrintInfo(&info);
            operation.setShowsPrintPanel(false);
            operation.setShowsProgressPanel(false);
            operation.setCanSpawnSeparateThread(true);
            // The view of the operation starts without a size and would print empty pages.
            if let Some(printed) = operation.view() {
                printed.setFrame(view.frame());
            }
            let delegate = PrintDelegate::alloc(mtm).set_ivars(Ivars {
                reply: Cell::new(Some(reply)),
            });
            let delegate: Retained<PrintDelegate> = msg_send![super(delegate), init];
            // `runOperation` prints empty pages for a WKWebView: it must run for a window.
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                window,
                Some(&delegate),
                Some(sel!(printOperationDidRun:success:contextInfo:)),
                std::ptr::null_mut(),
            );
            // The operation does not retain its delegate; the process ends with the export.
            std::mem::forget(delegate);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_export::PAGE_SIZES;
    use crate::test_dir::TestDir;

    #[test]
    fn every_page_size_has_a_paper_that_agrees_with_the_stylesheet() {
        let core = include_str!("../../src/app/core/export/export-core.ts");
        for size in PAGE_SIZES {
            let paper = paper(size).unwrap();
            assert!(paper.width_mm < paper.height_mm, "{size} is portrait");
            assert!(
                core.contains(&format!("{size}: {},", paper.width_mm)),
                "width of {size}"
            );
        }
        assert!(core.contains(&format!("const PAGE_MARGIN_MM = {MARGIN_MM};")));
        assert_eq!(paper("B7"), None);
    }

    #[test]
    fn a_complete_pdf_replaces_the_target() {
        let dir = TestDir::new("nixe-pdf-ok-");
        let target = dir.join("new folder/note.pdf");
        write_pdf(&target, |part| {
            assert_eq!(part.parent(), target.parent());
            assert!(!target.exists());
            fs::write(part, "%PDF-1.7 x").map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "%PDF-1.7 x");
        assert_eq!(fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_print_keeps_the_target_and_leaves_no_part() {
        let dir = TestDir::new("nixe-pdf-fail-");
        let target = dir.join("note.pdf");
        fs::write(&target, "old").unwrap();
        type Print = fn(&Path) -> Result<(), String>;
        let prints: [(Print, &str); 3] = [
            (
                |part| {
                    fs::write(part, "%PDF-half").unwrap();
                    Err("printer gone".into())
                },
                "printer gone",
            ),
            (|_| Ok(()), "no PDF was written"),
            (
                |part| fs::write(part, "<html>").map_err(|e| e.to_string()),
                "did not write a PDF",
            ),
        ];
        for (print, message) in prints {
            let error = write_pdf(&target, print).unwrap_err();
            assert!(error.contains(message), "{error}");
            assert_eq!(fs::read_to_string(&target).unwrap(), "old");
            assert_eq!(fs::read_dir(&*dir).unwrap().count(), 1);
        }
    }

    #[test]
    fn a_target_that_cannot_be_written_never_reaches_the_printer() {
        let dir = TestDir::new("nixe-pdf-dir-");
        fs::write(dir.join("file"), "x").unwrap();
        for target in [dir.to_path_buf(), dir.join("file/note.pdf")] {
            let printed = write_pdf(&target, |_| panic!("printed"));
            assert!(printed.is_err(), "{}", target.display());
        }
    }
}
