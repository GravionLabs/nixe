// Fails when a Rust test creates files under `env::temp_dir()` and nothing removes them.
//
// A test directory named with the process id is new on every `cargo test` run, so one that is not
// removed piles up in /tmp (a tmpfs ran out of inodes this way). The rule is in
// `docs/backend/tests.md`: use `TestDir` (unit tests) or `tempfile::TempDir` so the directory is
// removed when the guard drops, also when the test panics.
//
// The check is per file and a heuristic: a file whose test code names `env::temp_dir()`, creates
// files and has neither a guard nor a removal after use is reported.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEMP_ROOT = /\benv::temp_dir\(\)/;
const TEMP_CREATES = /\bcreate_dir(_all)?\(|\bfs::write\(|\bFile::create\(|\bOpenOptions\b/;
const TEMP_GUARD = /\bTempDir\b|\bTestDir\b|\btempdir\(|\btempfile::/;
const REMOVE = /\bremove_dir_all\(/g;

// A removal right before a create_dir only clears an earlier run's directory: with a pid in the
// name every run leaves a new one. Only a removal that is not followed by a create counts.
function removalsAfterUse(text) {
  let n = 0;
  for (const m of text.matchAll(REMOVE)) {
    if (!/\bcreate_dir(_all)?\(/.test(text.slice(m.index, m.index + 200))) n += 1;
  }
  return n;
}

/** True when the test code of a Rust file leaves directories behind in the temp directory. */
export function leaksTempDirs(text, { wholeFileIsTest = false } = {}) {
  if (!wholeFileIsTest) {
    // Only the test module: production code may name temp_dir().
    const at = text.indexOf("#[cfg(test)]");
    if (at === -1) return false;
    text = text.slice(at);
  }
  return (
    TEMP_ROOT.test(text) &&
    TEMP_CREATES.test(text) &&
    !TEMP_GUARD.test(text) &&
    removalsAfterUse(text) === 0
  );
}

export function findLeaks(root) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "src-tauri"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f.endsWith(".rs"));
  return files.filter((f) => {
    const text = readFileSync(resolve(root, f), "utf8");
    // Files under src-tauri/tests/ are test files as a whole.
    return leaksTempDirs(text, { wholeFileIsTest: f.startsWith("src-tauri/tests/") });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const leaks = findLeaks(root);
  if (leaks.length > 0) {
    console.error(
      "These Rust files create test directories under env::temp_dir() and never remove them:",
    );
    for (const f of leaks) console.error(`  ${f}`);
    console.error(
      "Use TestDir (src-tauri/src/test_dir.rs) or tempfile::TempDir; see docs/backend/tests.md.",
    );
    process.exit(1);
  }
  console.log("No Rust test leaves directories in the temp directory.");
}
