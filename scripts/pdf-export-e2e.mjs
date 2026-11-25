#!/usr/bin/env node
// End-to-end check of `nixe export <note|folder> --format pdf --out <target>` with a built app
// (#599, #600), run by the `pdf-export` job of ci.yml on every platform:
//
//   pnpm tauri build --debug --no-bundle
//   node scripts/pdf-export-e2e.mjs src-tauri/target/debug/nixe [directory for the PDFs]
//
// On Linux it needs a display (`xvfb-run -a node ...`).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argv, env, exit, platform } from "node:process";
import { pathToFileURL } from "node:url";

import { hasImage, mediaBoxes, pageCount } from "./pdf-info.mjs";

/** Width and height in PDF points (1/72 inch). */
const PAGES = { A4: [595.3, 841.9], A5: [419.5, 595.3], Letter: [612, 792] };
const TIMEOUT_MS = 180_000;
/** A red 8x8 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR42mO8IyfHgA0wMeAAg1MCAOBWAShOAhDlAAAAAElFTkSuQmCC",
  "base64",
);
const NOTE = `# First page

Math: $E = mc^2$

$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$

\`\`\`mermaid
flowchart LR
    A[Start] --> B[End]
\`\`\`

![square](square.png)

# Second page

The last line.
`;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function run(binary, args, cwd) {
  const result = spawnSync(binary, args, {
    cwd,
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: {
      ...env,
      // The check must not touch the app data of whoever runs it, nor reach a printer (Linux).
      XDG_DATA_HOME: join(cwd, "data"),
      XDG_CONFIG_HOME: join(cwd, "config"),
      CUPS_SERVER: "127.0.0.1:1",
    },
  });
  console.log(`$ nixe ${args.join(" ")}\n  exit ${result.status} ${result.signal ?? ""}`);
  if (result.stdout) console.log(`  stdout: ${result.stdout.trim()}`);
  if (result.stderr) console.log(`  stderr: ${result.stderr.trim()}`);
  check(!result.error, `the export did not run: ${result.error}`);
  return result;
}

export function main(binary, keep) {
  const work = mkdtempSync(join(tmpdir(), "nixe-pdf-e2e-"));
  try {
    const vault = join(work, "vault");
    const out = keep ? resolve(keep) : join(work, "out");
    mkdirSync(vault, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(vault, "Note.md"), NOTE);
    writeFileSync(join(vault, "square.png"), PNG);
    const export_ = (target, extra) =>
      run(
        binary,
        ["export", "Note", "--format", "pdf", "--out", target, "--vault", vault, ...extra],
        work,
      );

    for (const [size, flag] of [
      ["A4", "--light"],
      ["A5", "--dark"],
      ["Letter", "--light"],
    ]) {
      const target = join(out, `${platform}-${size}.pdf`);
      rmSync(target, { force: true });
      const result = export_(target, ["--page-size", size, flag]);
      check(result.status === 0, `${size}: exit ${result.status}`);
      // The command returned: the file is complete now.
      check(existsSync(target), `${size}: no file after the command returned`);
      check(
        result.stdout.replaceAll("\\", "/").includes(`${platform}-${size}.pdf`),
        `${size}: the path is not printed`,
      );
      const pdf = readFileSync(target);
      check(pdf.subarray(0, 5).toString() === "%PDF-", `${size}: not a PDF`);
      const pages = pageCount(pdf);
      const boxes = mediaBoxes(pdf);
      console.log(`  ${size}: ${pdf.length} bytes, ${pages} pages, MediaBox ${boxes.join(" | ")}`);
      // The page break before the second top-level heading.
      check(pages >= 2, `${size}: ${pages} pages, expected the page break`);
      // Its width tells it from the icon of a broken image.
      check(hasImage(pdf, 8), `${size}: the image is missing`);
      check(boxes.length > 0, `${size}: no MediaBox`);
      for (const box of boxes) {
        const [x0, y0, x1, y1] = box.split(" ").map(Number);
        const [width, height] = PAGES[size];
        check(
          Math.abs(x1 - x0 - width) < 2 && Math.abs(y1 - y0 - height) < 2,
          `${size}: page of ${x1 - x0} x ${y1 - y0} points`,
        );
      }
    }

    // A folder: one start, one PDF per published note, a failed note does not stop the others.
    const notes = join(vault, "folder");
    mkdirSync(join(notes, "sub"), { recursive: true });
    mkdirSync(join(notes, "skip"), { recursive: true });
    writeFileSync(join(notes, "A.md"), NOTE.replace("square.png", "../square.png"));
    writeFileSync(join(notes, "sub", "B.md"), NOTE.replace("square.png", "../../square.png"));
    writeFileSync(join(notes, "skip", "C.md"), "# C\n");
    writeFileSync(join(notes, "Draft.md"), "---\npublish: false\n---\n# Draft\n");
    const pdfs = join(out, `${platform}-folder`);
    rmSync(pdfs, { recursive: true, force: true });
    // A folder where the PDF of `A.md` goes: that note fails, `sub/B.md` comes after it.
    mkdirSync(join(pdfs, "A.pdf"), { recursive: true });
    const folder = run(
      binary,
      [
        "export",
        notes,
        "--format",
        "pdf",
        "--out",
        pdfs,
        "--exclude",
        "skip",
        "--vault",
        vault,
        "--page-size",
        "A5",
      ],
      work,
    );
    check(folder.status === 1, `folder with a failing note: exit ${folder.status}`);
    check(folder.stderr.includes("[1/2] A.md: failed"), "folder: the failure is not reported");
    check(folder.stderr.includes("[2/2] sub/B.md"), "folder: no progress");
    const written = folder.stdout.trim().split(/\r?\n/);
    check(
      written.length === 1 && written[0].replaceAll("\\", "/").endsWith("folder/sub/B.pdf"),
      `folder: written paths ${written}`,
    );
    const second = readFileSync(join(pdfs, "sub", "B.pdf"));
    check(pageCount(second) >= 2, "folder: the page break is missing");
    check(hasImage(second, 8), "folder: the image is missing");
    check(!existsSync(join(pdfs, "skip")), "folder: an excluded note was exported");
    check(!existsSync(join(pdfs, "Draft.pdf")), "folder: an unpublished note was exported");

    // Without the failure: both notes, next to themselves, exit 0.
    const beside = run(
      binary,
      ["export", notes, "--format", "pdf", "--out", ".", "--exclude", "skip", "--vault", vault],
      work,
    );
    check(beside.status === 0, `folder beside the notes: exit ${beside.status}`);
    for (const file of [join(notes, "A.pdf"), join(notes, "sub", "B.pdf")]) {
      const pdf = readFileSync(file);
      check(pdf.subarray(0, 5).toString() === "%PDF-", `${file}: not a PDF`);
      check(pageCount(pdf) >= 2 && hasImage(pdf, 8), `${file}: incomplete`);
    }

    // A target that cannot be written: exit 1 and a message.
    const failed = export_(vault, []);
    check(failed.status === 1, `a folder as target: exit ${failed.status}`);
    check(failed.stderr.includes("nixe:"), "a folder as target: no message");
    console.log("ok");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  const [binary, keep] = argv.slice(2);
  if (!binary) {
    console.error("usage: node scripts/pdf-export-e2e.mjs <nixe binary> [directory for the PDFs]");
    exit(2);
  }
  main(resolve(binary), keep);
}
