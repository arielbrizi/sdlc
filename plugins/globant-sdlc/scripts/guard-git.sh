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

# La branch default del remoto se resuelve, no se adivina. La lista estatica de
# arriba cubre los nombres habituales, pero un repo puede tener como default una
# branch con cualquier nombre — y ahi la lista no protege nada. Es exactamente
# lo que paso en un run real: la default era `feature/LOCAL-calculadora-...`, el
# ciclo commiteo y pusheo encima, y el hook no dijo nada porque el nombre no
# estaba en la lista.
#
# Se lee de refs locales: no hay red, no hay latencia. Si no se puede resolver
# —remoto sin `origin/HEAD` fetcheado— devuelve vacio y manda solo la lista.
default_branch() {
  local ref
  ref="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  [[ -n "$ref" ]] && { echo "${ref#origin/}"; return; }
  git config --get init.defaultBranch 2>/dev/null || true
}

# Branch base declarada por el run. Es la que el ciclo tiene que usar como punto
# de partida, no como lugar de trabajo: commitear ahi es lo que mezcla dos
# historias en un mismo PR.
base_branch() {
  local run_dir
  run_dir="$(ls -td "${CLAUDE_PROJECT_DIR:-$(pwd)}"/.claude/run/*/ 2>/dev/null | head -1)"
  [[ -z "$run_dir" || ! -f "${run_dir}/run.json" ]] && return
  grep -oE '"base_branch"[[:space:]]*:[[:space:]]*"[^"]*"' "${run_dir}/run.json" 2>/dev/null \
    | sed 's/.*"\([^"]*\)"$/\1/' || true
}

# `--force-with-lease` tambien es force push: el patron viejo pedia espacio o fin
# de linea despues de `--force` y lo dejaba pasar entero.
echo "$CMD" | grep -qE 'push .*(--force|--force-with-lease|-f)( |$)' && block "force push no permitido"
echo "$CMD" | grep -qE 'reset .*--hard'             && block "reset --hard no permitido en modo automatico"

# Comillas dobles: con simples `${PROTECTED}` viajaba literal al patron y la
# regla no matcheaba nunca — `git push origin main` pasaba derecho.
if echo "$CMD" | grep -qE 'git +push'; then
  DEFAULT="$(default_branch)"
  BASE="$(base_branch)"
  # `git push` a secas empuja la branch actual: si no hay destino explicito, el
  # destino es HEAD. Sin esto la regla solo cubria el push con refspec.
  DESTINO="$(echo "$CMD" | grep -oE 'push[^|;&]*' | awk '{print $NF}')"
  if [[ -z "$DESTINO" || "$DESTINO" == "push" || "$DESTINO" == -* || "$DESTINO" == "origin" ]]; then
    DESTINO="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  fi

  echo "$CMD" | grep -qE "push .*origin +(${PROTECTED})( |$)" && block "push directo a branch protegida"
  [[ -n "$DEFAULT" && "$DESTINO" == "$DEFAULT" ]] && block "push directo a ${DEFAULT}, que es la branch default del remoto"
  [[ -n "$BASE" && "$DESTINO" == "$BASE" ]] && block "push directo a ${BASE}, que es la branch base del run — la historia va en su propia branch"
fi

if echo "$CMD" | grep -qE 'git +commit'; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
  DEFAULT="$(default_branch)"
  BASE="$(base_branch)"

  echo "$BRANCH" | grep -qE "^(${PROTECTED})$" && block "commit directo sobre ${BRANCH}"
  [[ -n "$DEFAULT" && "$BRANCH" == "$DEFAULT" ]] && block "commit sobre ${BRANCH}, que es la branch default del remoto"
  [[ -n "$BASE" && "$BRANCH" == "$BASE" ]] && block "commit sobre ${BRANCH}, que es la branch base del run — crea feature/<ID>-<slug> primero"
fi

exit 0
