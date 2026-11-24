import assert from "node:assert/strict";
import { test } from "node:test";
import { leaksTempDirs } from "./check-test-temp-dirs.mjs";

const leak = `
#[cfg(test)]
mod tests {
    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("nixe-x-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }
}
`;

const guarded = `
#[cfg(test)]
mod tests {
    fn tmp(name: &str) -> TestDir {
        let dir = TestDir::new("nixe-x-");
        std::fs::write(dir.join("a"), "").unwrap();
        dir
    }
}
`;

const removedAfterUse = `
#[cfg(test)]
mod tests {
    #[test]
    fn t() {
        let dir = std::env::temp_dir().join("nixe-x-fixed");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a"), "").unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
`;

const productionOnly = `
fn stdin_file_path() -> PathBuf {
    std::env::temp_dir().join("nixe-stdin").join("stdin.md")
}
fn save() { std::fs::create_dir_all("x").unwrap(); }

#[cfg(test)]
mod tests {
    #[test]
    fn t() { assert!(true); }
}
`;

test("a pid-named directory that is only removed before it is created is a leak", () => {
  assert.equal(leaksTempDirs(leak), true);
});

test("a TestDir or tempfile guard is not a leak", () => {
  assert.equal(leaksTempDirs(guarded), false);
  assert.equal(leaksTempDirs(leak.replace("PathBuf {", "TempDir {")), false);
  assert.equal(leaksTempDirs(`${leak}\nuse tempfile::tempdir;\n`), false);
});

test("a removal after the use is not a leak", () => {
  assert.equal(leaksTempDirs(removedAfterUse), false);
});

test("production code that names temp_dir() is not scanned", () => {
  assert.equal(leaksTempDirs(productionOnly), false);
  assert.equal(leaksTempDirs("fn a() { std::env::temp_dir(); fs::write(p, 1); }"), false);
});

test("a file under tests/ is scanned as a whole", () => {
  const integration = leak.replace("#[cfg(test)]\nmod tests {", "mod tests {");
  assert.equal(leaksTempDirs(integration), false);
  assert.equal(leaksTempDirs(integration, { wholeFileIsTest: true }), true);
});
