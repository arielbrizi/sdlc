#!/usr/bin/env bash
# Registra el cierre de cada subagente para trazabilidad del run.
set -uo pipefail

INPUT="$(cat)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
LOG_DIR="${PROJECT_DIR}/.claude/run"

[[ ! -d "$LOG_DIR" ]] && exit 0

META="$(printf '%s' "$INPUT" | node -e '
let raw = "";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try {
    const d = JSON.parse(raw);
    const agent = d.agent_type || d.subagent_type || d.agent || d.agent_id || "unknown";
    const message = String(d.last_assistant_message || d.result || "");
    const verdict = message.match(/"verdict"\s*:\s*"([A-Z_]+)"/i)?.[1] || "unavailable";
    process.stdout.write(`${agent}\t${verdict}`);
  } catch { process.stdout.write("unknown\tunavailable"); }
});
' 2>/dev/null || printf 'unknown\tunavailable')"
AGENT="${META%%$'\t'*}"
VERDICT="${META#*$'\t'}"

LATEST_RUN="$(ls -td "${LOG_DIR}"/*/ 2>/dev/null | head -1)"
[[ -z "$LATEST_RUN" ]] && exit 0

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) agent=${AGENT} verdict=${VERDICT} finished" >> "${LATEST_RUN}/timeline.log"
exit 0
