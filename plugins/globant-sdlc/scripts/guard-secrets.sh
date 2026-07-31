#!/usr/bin/env bash
# Bloquea acceso a archivos que tipicamente contienen secretos.
# Exit 2 = bloquear la tool call.
set -euo pipefail

INPUT="$(cat)"
FILE_PATH="$(echo "$INPUT" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)"

[[ -z "$FILE_PATH" ]] && exit 0

BLOCKED_PATTERNS=(
  '\.env($|\.)'
  'credentials'
  'secrets?\.(ya?ml|json|toml)$'
  'id_rsa'
  '\.pem$'
  '\.p12$'
  '\.keystore$'
  'terraform\.tfstate'
)

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$FILE_PATH" | grep -qE "$pattern"; then
    echo "BLOQUEADO por politica de Globant: ${FILE_PATH} puede contener secretos." >&2
    echo "Si necesitas una variable de entorno, referenciala por nombre sin leer el archivo." >&2
    exit 2
  fi
done
exit 0
