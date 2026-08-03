#!/usr/bin/env bash
# resolve-story.sh — detecta el tracker a partir del ID y prepara el directorio del run.
#
# Uso: resolve-story.sh <ID> [tracker]
#      resolve-story.sh <ID> --tracker <tracker>
# Salida (stdout, JSON):
#   { "id": "...", "tracker": "jira", "run_dir": "...", "story_path": "...", "mcp_hint": "..." }
#
# El script NO llama al tracker: resuelve el enrutamiento y le dice al agente qué
# herramienta MCP usar. La lectura la hace el agente, que sabe mapear los campos.
#
# El tracker 'manual' es la excepción: ahí la historia ya está escrita a mano en
# story.json (la tipea el dev en el studio) y no hay nada que consultar.

set -euo pipefail

ID_RAW="${1:-}"
shift || true
TRACKER_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tracker)
      [[ -n "${2:-}" ]] || { echo "error: --tracker requiere un valor" >&2; exit 2; }
      TRACKER_ARG="$2"
      shift 2
      ;;
    jira|ado|github|manual)
      [[ -z "$TRACKER_ARG" ]] || { echo "error: tracker especificado más de una vez" >&2; exit 2; }
      TRACKER_ARG="$1"
      shift
      ;;
    *)
      echo "error: argumento desconocido '$1'" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$ID_RAW" ]]; then
  echo "error: falta el ID de la historia" >&2
  exit 1
fi

ID="${ID_RAW#\#}"
[[ "$ID" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "error: ID de historia inválido '${ID_RAW}'" >&2; exit 2; }
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TRACKER_DEFAULT="${CLAUDE_PLUGIN_OPTION_TRACKER_DEFAULT:-jira}"

RUN_DIR="${PROJECT_DIR}/.claude/run/${ID}"
STORY_PATH="${RUN_DIR}/story.json"

# Una historia escrita a mano ya está en disco antes de que arranque el run.
story_is_manual() {
  [[ -f "$STORY_PATH" ]] && grep -Eq '"tracker"[[:space:]]*:[[:space:]]*"manual"' "$STORY_PATH"
}

detect_tracker() {
  if [[ -n "$TRACKER_ARG" ]]; then
    echo "$TRACKER_ARG"; return
  fi
  if story_is_manual; then
    echo "manual"; return
  fi
  if [[ "$ID" =~ ^[A-Z][A-Z0-9]+-[0-9]+$ ]]; then
    echo "jira"; return
  fi
  if [[ "$ID" =~ ^[0-9]+$ ]]; then
    if git -C "$PROJECT_DIR" remote -v 2>/dev/null | grep -qi 'github\.com'; then
      echo "github"
    else
      echo "ado"
    fi
    return
  fi
  echo "$TRACKER_DEFAULT"
}

TRACKER="$(detect_tracker)"

case "$TRACKER" in
  jira)   MCP_HINT="Usá las tools del MCP 'jira' para leer el issue ${ID}." ;;
  ado)    MCP_HINT="Usá las tools del MCP 'ado' para leer el work item ${ID}." ;;
  github) MCP_HINT="Usá las tools del MCP 'github' para leer el issue #${ID}." ;;
  manual)
    if [[ ! -f "$STORY_PATH" ]]; then
      echo "error: tracker 'manual' pero no hay historia escrita en ${STORY_PATH}." >&2
      echo "       Escribila en el studio (pestaña Historia) o creá el archivo a mano." >&2
      exit 3
    fi
    if ! grep -Eq '"title"[[:space:]]*:[[:space:]]*"[^"]+"' "$STORY_PATH"; then
      echo "error: la historia en ${STORY_PATH} no tiene título." >&2
      exit 3
    fi
    MCP_HINT="La historia está escrita a mano en ${STORY_PATH}. No consultes ningún MCP de tracker: leé ese archivo tal cual, ya está en el esquema canónico."
    ;;
  *)
    echo "error: tracker desconocido '${TRACKER}' (jira | ado | github | manual)" >&2
    exit 2
    ;;
esac

mkdir -p "$RUN_DIR"

# Marca de inicio del run, para auditoría.
cat > "${RUN_DIR}/run.json" <<JSON
{
  "id": "${ID}",
  "tracker": "${TRACKER}",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "started_by": "$(git config user.email 2>/dev/null || echo unknown)",
  "base_branch": "${CLAUDE_PLUGIN_OPTION_BASE_BRANCH:-develop}",
  "repo": "$(basename "$PROJECT_DIR")"
}
JSON

cat <<JSON
{
  "id": "${ID}",
  "tracker": "${TRACKER}",
  "run_dir": "${RUN_DIR}",
  "story_path": "${STORY_PATH}",
  "mcp_hint": "${MCP_HINT}"
}
JSON
