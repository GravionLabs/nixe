import type { ImportReport } from "../file/backend";

/**
 * The text of the notification for the import of `.obsidian/` into `.nixe/` (#441): what was
 * imported with the files, and that the files are changes of the next Git commit. A failure is
 * named as a warning. `null` when the import had nothing to say.
 */
export function importNotice(report: ImportReport): string | null {
  const parts: string[] = [];
  if (report.written.length > 0) {
    parts.push(
      `Imported the settings from ${report.sources.join(", ")} into ${report.written.join(", ")}. ` +
        "The new files are changes of the next commit.",
    );
  }
  if (report.warnings.length > 0) {
    parts.push(
      `Warning: import of .obsidian/ incomplete (${report.warnings.join("; ")}). ` +
        "Nixe keeps reading .obsidian/.",
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
