#!/usr/bin/env bash
# Writes SHA256SUMS over the installer assets in a directory and checks it.
# Usage: release-checksums.sh <dir>
# Skipped: *.sig (updater signatures), latest.json (updater manifest), SHA256SUMS itself.
set -euo pipefail

dir="${1:?usage: release-checksums.sh <dir>}"
cd "$dir"

files=()
while IFS= read -r -d '' f; do
  files+=("${f#./}")
done < <(find . -maxdepth 1 -type f ! -name '*.sig' ! -name 'latest.json' ! -name 'SHA256SUMS' -print0 | sort -z)

[ "${#files[@]}" -gt 0 ] || { echo "no assets to checksum in $dir" >&2; exit 1; }

hash_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

hash_cmd "${files[@]}" > SHA256SUMS
if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS; else shasum -a 256 -c SHA256SUMS; fi
