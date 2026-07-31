#!/usr/bin/env bash
# resolve-story.sh — detecta el tracker a partir del ID y prepara el directorio del run.
#
# Uso: resolve-story.sh <ID> [tracker]
# Salida (stdout, JSON):
#   { "id": "...", "tracker": "jira", "run_dir": "...", "story_path": "...", "mcp_hint": "..." }
#
# El script NO llama al tracker: resuelve el enrutamiento y le dice al agente qué
# herramienta MCP usar. La lectura la hace el agente, que sabe mapear los campos.

set -euo pipefail

ID_RAW="${1:-}"
TRACKER_ARG="${2:-}"

if [[ -z "$ID_RAW" ]]; then
  echo "error: falta el ID de la historia" >&2
  exit 1
fi

ID="${ID_RAW#\#}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TRACKER_DEFAULT="${CLAUDE_PLUGIN_OPTION_TRACKER_DEFAULT:-jira}"

detect_tracker() {
  if [[ -n "$TRACKER_ARG" ]]; then
    echo "$TRACKER_ARG"; return
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
  *)
    echo "error: tracker desconocido '${TRACKER}' (jira | ado | github)" >&2
    exit 2
    ;;
esac

RUN_DIR="${PROJECT_DIR}/.claude/run/${ID}"
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
  "story_path": "${RUN_DIR}/story.json",
  "mcp_hint": "${MCP_HINT}"
}
JSON
