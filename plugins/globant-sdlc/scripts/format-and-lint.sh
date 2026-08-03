#!/usr/bin/env bash
# Formatea y linta el archivo modificado segun su extension.
# No bloquea: informa. Exit 0 siempre salvo error de infraestructura.
#
# El hook corre sincronico en cada Write/Edit: lo que tarde aca se lo come el
# dev en cada iteracion. Por eso resolvemos el binario nosotros en vez de
# delegar en `npx`, que cuesta ~1.2s de arranque por invocacion aunque el
# formateador no este instalado — y se pagaba dos veces por archivo tocado.
set -uo pipefail

INPUT="$(cat)"
FILE_PATH="$(echo "$INPUT" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/' || true)"

[[ -z "$FILE_PATH" || ! -f "$FILE_PATH" ]] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Resuelve un ejecutable: primero el del proyecto, despues el del PATH.
# Devuelve 1 si no existe en ninguno de los dos, y ahi el formateador
# directamente no corre: un repo sin prettier no deberia pagar nada por
# tenerlo configurado en el hook.
resolve_bin() {
  local name="$1"
  local local_bin="${PROJECT_DIR}/node_modules/.bin/${name}"
  if [[ -x "$local_bin" ]]; then
    echo "$local_bin"
    return 0
  fi
  command -v "$name" 2>/dev/null && return 0
  return 1
}

# La salida se descarta a proposito: lo que el formateador imprime en stdout
# vuelve al transcript como contexto, y una linea por edicion es ruido que se
# paga en cada turno posterior.
run_if_available() {
  local bin
  bin="$(resolve_bin "$1")" || return 0
  shift
  "$bin" "$@" >/dev/null 2>&1 || true
}

case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx)
    run_if_available prettier --write "$FILE_PATH"
    run_if_available eslint --fix "$FILE_PATH"
    ;;
  *.py)
    run_if_available ruff format "$FILE_PATH"
    run_if_available ruff check --fix "$FILE_PATH"
    ;;
  *.java)
    run_if_available google-java-format -i "$FILE_PATH"
    ;;
  *.go)
    run_if_available gofmt -w "$FILE_PATH"
    ;;
esac
exit 0
