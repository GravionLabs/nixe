#!/usr/bin/env python3
"""Generates a throwaway vault of ~1000 Markdown notes for the git spike (#60).

Usage: python3 scripts/gen-test-vault.py <empty-dir> [count=1000]
Then, to seed the private test repo yourself (the script never pushes):
  cd <dir> && git init -b main && git add -A && git commit -m "seed vault"
  git remote add origin https://github.com/GravionLabs/nixe-test-vault.git && git push -u origin main
"""
import random
import sys
from pathlib import Path

root = Path(sys.argv[1])
count = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
random.seed(60)
for i in range(count):
    folder = root / f"folder-{i % 25:02d}"
    folder.mkdir(parents=True, exist_ok=True)
    body = "\n".join(f"Line {j} lorem ipsum {random.random():.6f}" for j in range(60))
    (folder / f"note-{i:04d}.md").write_text(f"# Note {i}\n\n{body}\n", encoding="utf-8")
print(f"wrote {count} notes to {root}")
