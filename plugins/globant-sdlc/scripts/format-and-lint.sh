#!/usr/bin/env bash
# Formatea y linta el archivo modificado segun su extension.
# No bloquea: informa. Exit 0 siempre salvo error de infraestructura.
set -uo pipefail

INPUT="$(cat)"
FILE_PATH="$(echo "$INPUT" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)"

[[ -z "$FILE_PATH" || ! -f "$FILE_PATH" ]] && exit 0

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx)
    command -v npx >/dev/null && npx --no-install prettier --write "$FILE_PATH" 2>/dev/null
    command -v npx >/dev/null && npx --no-install eslint --fix "$FILE_PATH" 2>/dev/null
    ;;
  *.py)
    command -v ruff >/dev/null && ruff format "$FILE_PATH" 2>/dev/null && ruff check --fix "$FILE_PATH" 2>/dev/null
    ;;
  *.java)
    command -v google-java-format >/dev/null && google-java-format -i "$FILE_PATH" 2>/dev/null
    ;;
  *.go)
    command -v gofmt >/dev/null && gofmt -w "$FILE_PATH" 2>/dev/null
    ;;
esac
exit 0
