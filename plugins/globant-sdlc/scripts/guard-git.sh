#!/usr/bin/env bash
# Bloquea operaciones git destructivas o sobre branches protegidas.
set -euo pipefail

INPUT="$(cat)"
CMD="$(echo "$INPUT" | grep -oE '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)"

[[ -z "$CMD" ]] && exit 0

PROTECTED="${GLOBANT_PROTECTED_BRANCHES:-main|master|develop|release/.*}"

block() {
  echo "BLOQUEADO por politica de Globant: $1" >&2
  exit 2
}

echo "$CMD" | grep -qE 'push .*(--force|-f)( |$)'   && block "force push no permitido"
echo "$CMD" | grep -qE 'reset .*--hard'             && block "reset --hard no permitido en modo automatico"
# Comillas dobles: con simples `${PROTECTED}` viajaba literal al patron y la
# regla no matcheaba nunca — `git push origin main` pasaba derecho.
echo "$CMD" | grep -qE "push .*origin +(${PROTECTED})( |$)" && block "push directo a branch protegida"
echo "$CMD" | grep -qE 'git +commit' && {
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  echo "$BRANCH" | grep -qE "^(${PROTECTED})$" && block "commit directo sobre ${BRANCH}"
}
exit 0
