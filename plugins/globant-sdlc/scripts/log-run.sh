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

# El veredicto es lo que hace util a este registro: sin el, `timeline.log` dice
# que un agente cerro pero no si paso, bloqueo o fallo, y quien reanuda el run
# tiene que volver a correrlo para averiguarlo. Best-effort: si la salida del
# agente no trae `verdict`, se anota igual el cierre.
# El JSON del agente viaja embebido como string dentro del payload del hook, con
# las comillas escapadas. Sin desescapar primero, el patron no matchea nunca.
VERDICT="$(echo "$INPUT" | sed 's/\\"/"/g' \
  | grep -oE '"verdict"[[:space:]]*:[[:space:]]*"[^"]*"' | tail -1 \
  | sed 's/.*"\([^"]*\)"$/\1/' || true)"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) agent=${AGENT} finished verdict=${VERDICT:-unknown}" >> "${LATEST_RUN}/timeline.log"
exit 0
