#!/usr/bin/env bash
# Bloquea operaciones git destructivas o sobre branches protegidas.
set -euo pipefail

INPUT="$(cat)"
[[ -x "${CLAUDE_PLUGIN_ROOT:-}/scripts/record-hook.sh" ]] \
  && "${CLAUDE_PLUGIN_ROOT}/scripts/record-hook.sh" PreToolUse guard-git.sh || true
CMD="$(printf '%s' "$INPUT" | node -e '
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try { process.stdout.write(String(JSON.parse(raw)?.tool_input?.command || "")); }
  catch { process.exit(0); }
});
' 2>/dev/null || true)"

[[ -z "$CMD" ]] && exit 0

PROTECTED="${GLOBANT_PROTECTED_BRANCHES:-main|master|develop|release/.*}"
CONFIGURED_BASE="${CLAUDE_PLUGIN_OPTION_BASE_BRANCH:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

block() {
  echo "BLOQUEADO por politica de Globant: $1" >&2
  exit 2
}

printf '%s' "$CMD" | grep -qE '(^|[[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push([[:space:]]|$)' && IS_PUSH=1 || IS_PUSH=0

if [[ "$IS_PUSH" -eq 1 ]]; then
  printf '%s' "$CMD" | grep -qE '(^|[[:space:]])--force($|[=[:space:]])|(^|[[:space:]])--force-with-lease($|[=[:space:]])|(^|[[:space:]])--force-if-includes($|[=[:space:]])|(^|[[:space:]])-[A-Za-z]*f[A-Za-z]*($|[[:space:]])' \
    && block "force push no permitido"

  PUSH_BRANCH="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  printf '%s' "$PUSH_BRANCH" | grep -qE "^(${PROTECTED})$" \
    && block "push iniciado desde la branch protegida ${PUSH_BRANCH}"
  [[ -n "$CONFIGURED_BASE" && "$PUSH_BRANCH" == "$CONFIGURED_BASE" ]] \
    && block "push iniciado desde la branch base configurada ${PUSH_BRANCH}"

  # Cubre `main`, `HEAD:main`, `refs/heads/main`, `+main` y refspecs equivalentes.
  printf '%s' "$CMD" | grep -qE "(^|[[:space:]:+])(${PROTECTED})([[:space:];&|]|$)" \
    && block "push directo a branch protegida"
fi

printf '%s' "$CMD" | grep -qE '(^|[[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+reset([[:space:]].*)?--hard([[:space:]]|$)' \
  && block "reset --hard no permitido en modo automatico"
if [[ -n "$CONFIGURED_BASE" ]]; then
  BASE_PATTERN="$(printf '%s' "$CONFIGURED_BASE" | sed 's/[][\\.^$*+?{}|()]/\\&/g')"
  [[ "$IS_PUSH" -eq 1 ]] && printf '%s' "$CMD" | grep -qE "(^|[[:space:]:+])${BASE_PATTERN}([[:space:];&|]|$)" \
    && block "push directo a la branch base configurada ${CONFIGURED_BASE}"
fi
printf '%s' "$CMD" | grep -qE '(^|[[:space:]])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+commit([[:space:]]|$)' && {
  BRANCH="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  echo "$BRANCH" | grep -qE "^(${PROTECTED})$" && block "commit directo sobre ${BRANCH}"
  [[ -n "$CONFIGURED_BASE" && "$BRANCH" == "$CONFIGURED_BASE" ]] \
    && block "commit directo sobre la branch base configurada ${BRANCH}"
}
exit 0
