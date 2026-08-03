#!/usr/bin/env bash
# Registra una activación real de hook para que el Studio pueda contarla.
# Es telemetría best-effort: nunca bloquea ni cambia el resultado del hook.
set -uo pipefail

EVENT="${1:-}"
SCRIPT="${2:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_ROOT="${PROJECT_DIR}/.claude/run"

[[ "$EVENT" =~ ^[A-Za-z]+$ ]] || exit 0
[[ "$SCRIPT" =~ ^[A-Za-z0-9._-]+\.sh$ ]] || exit 0
[[ -d "$LOG_ROOT" ]] || exit 0

RUN_KEY="${FLOW360_STORY_ID:-}"
STUDIO_RUN="${FLOW360_STUDIO_RUN_ID:-}"
[[ "$STUDIO_RUN" =~ ^[A-Za-z0-9-]{0,64}$ ]] || STUDIO_RUN=""
if [[ "$RUN_KEY" =~ ^[A-Za-z0-9-]{1,40}$ && -d "${LOG_ROOT}/${RUN_KEY}" ]]; then
  LATEST_RUN="${LOG_ROOT}/${RUN_KEY}/"
else
  LATEST_RUN="$(ls -td "${LOG_ROOT}"/*/ 2>/dev/null | head -1)"
fi
[[ -n "$LATEST_RUN" ]] || exit 0

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"event":"%s","script":"%s","run":"%s","at":"%s"}\n' \
  "$EVENT" "$SCRIPT" "$STUDIO_RUN" "$NOW" \
  >> "${LATEST_RUN}/hook-events.jsonl" 2>/dev/null || true
exit 0
