#!/usr/bin/env bash
# SPIKE (temporary): A5 and 18 mm in the CSS, Legal and 40 mm natively.
set -eu
bin="$PWD/$1"; out="$PWD/$2"; w="$(mktemp -d)"
mkdir -p "$w/vault" "$out"
{ printf '# First page\n\n'; for i in $(seq 1 60); do printf 'Line %s with enough words to reach from the left margin to the right margin of the page, again and again and again.\n\n' "$i"; done; } > "$w/vault/Note.md"
export XDG_DATA_HOME="$w/data" XDG_CONFIG_HOME="$w/cfg" CUPS_SERVER=127.0.0.1:1
for s in plain spike; do
  if [ $s = spike ]; then export NIXE_PDF_SPIKE=1; fi
  "$bin" export Note --format pdf --page-size A5 --dark --out "$out/$s.pdf" --vault "$w/vault"
done
unset NIXE_PDF_SPIKE
printf '# M\n\n```mermaid\nflowchart LR\n    A[Start] --> B[End]\n```\n' > "$w/vault/M.md"
"$bin" export M --format html --out "$out/mermaid.html" --vault "$w/vault"
"$bin" export M --format pdf --out "$out/mermaid.pdf" --vault "$w/vault"
