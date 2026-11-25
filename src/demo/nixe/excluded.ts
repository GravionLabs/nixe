// The commands of the app that the demo backend does not answer (#403), each with its reason.
// `demo.spec.ts` fails when a command of `core/file/backend.ts` or `core/terminal/terminal-backend.ts`
// is neither answered nor listed here, when a listed command is answered after all, and when an
// entry names a command the app no longer has. A call of an excluded command fails the run with its name.

const REWRITE = "rewrites links across notes in the Rust core; the demo vault only reads and edits";
const DISK = "writes to a disk the browser does not have";
const NETWORK = "needs a network, a remote and the GitHub CLI; the browser build has none";

export const EXCLUDED: Readonly<Record<string, string>> = {
  rename_path: REWRITE,
  trash_path: REWRITE,
  relink_preview: REWRITE,
  extract_preview: REWRITE,
  extract_text: REWRITE,
  merge_preview: REWRITE,
  merge_note: REWRITE,
  replace_preview: "the find-and-replace over the vault runs in the Rust core",
  replace_apply: "the find-and-replace over the vault runs in the Rust core",
  link_mention: REWRITE,
  undo_vault_operation: "the vault operations above are not answered, so there is none to undo",
  git_restore_note: "restores a note from a Git object store the demo does not have",
  git_discard_note: "restores a note from a Git object store the demo does not have",
  save_attachment: DISK,
  import_attachment: DISK,
  write_export_file: DISK,
  print_export_pdf: DISK,
  export_site: DISK,
  git_clone_vault: NETWORK,
  git_clone_cancel: NETWORK,
  git_provider_login: NETWORK,
  git_provider_cancel: NETWORK,
};
