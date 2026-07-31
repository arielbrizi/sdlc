#!/usr/bin/env bash
# Registra el cierre de cada subagente para trazabilidad del run.
set -uo pipefail

INPUT="$(cat)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_DIR="${PROJECT_DIR}/.claude/run"

[[ ! -d "$LOG_DIR" ]] && exit 0

AGENT="$(echo "$INPUT" | grep -oE '"(agent|subagent_type)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || echo unknown)"

LATEST_RUN="$(ls -td "${LOG_DIR}"/*/ 2>/dev/null | head -1)"
[[ -z "$LATEST_RUN" ]] && exit 0

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) agent=${AGENT} finished" >> "${LATEST_RUN}/timeline.log"
exit 0
