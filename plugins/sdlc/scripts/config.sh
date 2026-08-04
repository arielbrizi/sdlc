#!/usr/bin/env bash
# config.sh — resuelve qué agentes e integraciones están habilitados en este repo.
#
# Uso:
#   config.sh [json]                  imprime la config efectiva
#   config.sh agent <nombre>          exit 0 si está habilitado, 1 si no
#   config.sh design <figma|storybook> idem
#
# La config vive en el repo objetivo, no en el plugin:
#
#   <repo>/.claude/sdlc.json
#
# Es una decisión por proyecto, no por persona. Que un repo tenga UI que revisar
# es una propiedad del repo, y se versiona con él: el que clona hereda la misma
# configuración del ciclo, sin tener que enterarse por Slack.
#
# El formato es deliberadamente plano —un nivel, booleanos en su propia línea—
# para poder leerlo sin jq. Si el archivo no existe, no parsea o le falta una
# clave, se cae al default. Los defaults están elegidos para que ese camino sea
# siempre el seguro: los agentes que auditan quedan habilitados y los que
# dependen de una integración externa, deshabilitados.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CONFIG_FILE="${PROJECT_DIR}/.claude/sdlc.json"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# ---------------------------------------------------------------- defaults

# Un repo de backend no tiene UI que revisar: el agente de diseño no tendría con
# qué trabajar y sus hallazgos serían ruido. Por eso arranca apagado y lo
# enciende el proyecto que sí tiene frontend.
default_agent() {
  case "$1" in
    ux) echo false ;;
    *)  echo true ;;
  esac
}

# Figma y Storybook salen apagados por lo mismo, y además por separado: un
# equipo puede tener design system en Storybook sin que el diseño viva en Figma,
# o al revés.
default_design() { echo false; }

# ------------------------------------------------------------------ lectura

# Extrae el bloque `"<seccion>": { ... }` y busca ahí adentro. Sin esto, una
# clave `ux` dentro de `agents` se confundiría con cualquier otra `ux` del
# archivo.
leer_bool() {
  local seccion="$1" clave="$2" fallback="$3" blob val
  [[ -f "$CONFIG_FILE" ]] || { echo "$fallback"; return; }
  blob="$(sed -n "/\"${seccion}\"[[:space:]]*:[[:space:]]*{/,/}/p" "$CONFIG_FILE" 2>/dev/null || true)"
  val="$(printf '%s' "$blob" \
    | grep -oE "\"${clave}\"[[:space:]]*:[[:space:]]*(true|false)" \
    | head -1 | grep -oE '(true|false)$' || true)"
  [[ -n "$val" ]] && echo "$val" || echo "$fallback"
}

leer_str() {
  local seccion="$1" clave="$2" fallback="$3" blob val
  [[ -f "$CONFIG_FILE" ]] || { echo "$fallback"; return; }
  blob="$(sed -n "/\"${seccion}\"[[:space:]]*:[[:space:]]*{/,/}/p" "$CONFIG_FILE" 2>/dev/null || true)"
  val="$(printf '%s' "$blob" \
    | grep -oE "\"${clave}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  [[ -n "$val" ]] && echo "$val" || echo "$fallback"
}

# Los agentes salen del plugin en disco, no de una lista escrita acá: agregar un
# agente nuevo no obliga a tocar este script.
agentes() {
  local f
  for f in "${PLUGIN_ROOT}"/agents/*.md; do
    [[ -e "$f" ]] || continue
    basename "$f" .md
  done
}

agente_habilitado() {
  [[ "$(leer_bool agents "$1" "$(default_agent "$1")")" == "true" ]]
}

design_habilitado() {
  [[ "$(leer_bool "$1" enabled "$(default_design)")" == "true" ]]
}

# -------------------------------------------------------------------- salida

imprimir_json() {
  local first=1 a
  printf '{\n  "config_file": "%s",\n  "exists": %s,\n  "agents": {' \
    "$CONFIG_FILE" "$([[ -f "$CONFIG_FILE" ]] && echo true || echo false)"
  for a in $(agentes); do
    [[ $first -eq 0 ]] && printf ','
    printf '\n    "%s": %s' "$a" "$(leer_bool agents "$a" "$(default_agent "$a")")"
    first=0
  done
  printf '\n  },\n'
  printf '  "figma": { "enabled": %s, "url": "%s", "file_key": "%s", "node_id": "%s" },\n' \
    "$(leer_bool figma enabled "$(default_design)")" \
    "$(leer_str figma url '')" \
    "$(leer_str figma file_key '')" \
    "$(leer_str figma node_id '')"
  printf '  "storybook": { "enabled": %s, "dir": "%s", "url": "%s" }\n}\n' \
    "$(leer_bool storybook enabled "$(default_design)")" \
    "$(leer_str storybook dir '.storybook')" \
    "$(leer_str storybook url '')"
}

case "${1:-json}" in
  json)
    imprimir_json
    ;;
  agent)
    [[ -n "${2:-}" ]] || { echo "error: falta el nombre del agente" >&2; exit 2; }
    if agente_habilitado "$2"; then echo true; else echo false; exit 1; fi
    ;;
  design)
    [[ "${2:-}" =~ ^(figma|storybook)$ ]] || { echo "error: esperaba figma o storybook" >&2; exit 2; }
    if design_habilitado "$2"; then echo true; else echo false; exit 1; fi
    ;;
  agents)
    agentes
    ;;
  *)
    echo "uso: config.sh [json|agent <nombre>|design <figma|storybook>|agents]" >&2
    exit 2
    ;;
esac
