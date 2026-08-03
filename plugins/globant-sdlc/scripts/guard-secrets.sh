#!/usr/bin/env bash
# Bloquea acceso a archivos que tipicamente contienen secretos.
# Exit 2 = bloquear la tool call.
set -euo pipefail

INPUT="$(cat)"
[[ -x "${CLAUDE_PLUGIN_ROOT:-}/scripts/record-hook.sh" ]] \
  && "${CLAUDE_PLUGIN_ROOT}/scripts/record-hook.sh" PreToolUse guard-secrets.sh || true
FIELDS="$(printf '%s' "$INPUT" | node -e '
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(raw)?.tool_input || {};
    process.stdout.write([input.file_path, input.path, input.notebook_path, input.command]
      .filter(Boolean).map(String).join("\n"));
  } catch { process.exit(0); }
});
' 2>/dev/null || true)"

[[ -z "$FIELDS" ]] && exit 0

BLOCKED_PATTERNS=(
  "(^|[^A-Za-z0-9_.-])\\.env($|[^A-Za-z0-9_.-])"
  "(^|[^A-Za-z0-9_.-])\\.env\\.(local|dev|development|test|staging|prod|production)($|[^A-Za-z0-9_.-])"
  "(^|[^A-Za-z0-9_.-])credentials?(\\.(ya?ml|json|toml|ini|conf))?($|[^A-Za-z0-9_.-])"
  "(^|[^A-Za-z0-9_.-])secrets?\\.(ya?ml|json|toml)($|[^A-Za-z0-9_.-])"
  "(^|[^A-Za-z0-9_.-])id_rsa($|[^A-Za-z0-9_.-])"
  "\\.pem($|[^A-Za-z0-9_.-])"
  "\\.p12($|[^A-Za-z0-9_.-])"
  "\\.keystore($|[^A-Za-z0-9_.-])"
  "terraform\\.tfstate($|[^A-Za-z0-9_.-])"
)

while IFS= read -r FIELD; do
  for pattern in "${BLOCKED_PATTERNS[@]}"; do
    if printf '%s' "$FIELD" | grep -qiE "$pattern"; then
      echo "BLOQUEADO por politica de Globant: ${FIELD} puede contener secretos." >&2
      echo "Si necesitas una variable de entorno, referenciala por nombre sin leer el archivo." >&2
      exit 2
    fi
  done
done <<< "$FIELDS"
exit 0
