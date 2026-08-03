#!/usr/bin/env bash
# Impide invocar un subagente que el proyecto tiene deshabilitado.
#
# Deshabilitar un agente tiene que significar que no corre, no que idealmente no
# debería correr. Un prompt es una sugerencia fuerte; esto es la barrera.
#
# Qué NO bloquea, que es lo que evita que el equipo termine desactivando el hook:
#   - Task sin subagent_type
#   - subagentes que no son de este plugin (general-purpose, Explore, los que
#     traiga el repo objetivo)
#   - cualquier agente habilitado, que es el caso normal
#   - si config.sh no está o falla, deja pasar: un hook roto no puede frenar el
#     ciclo entero

set -uo pipefail

INPUT="$(cat)"
[[ -x "${CLAUDE_PLUGIN_ROOT:-}/scripts/record-hook.sh" ]] \
  && "${CLAUDE_PLUGIN_ROOT}/scripts/record-hook.sh" PreToolUse guard-agents.sh || true
HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${HERE}/config.sh"

[[ -x "$CONFIG" ]] || exit 0

RAW="$(printf '%s' "$INPUT" \
  | grep -oE '"subagent_type"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"

[[ -z "$RAW" ]] && exit 0

# Los subagentes de un plugin llegan calificados: `globant-sdlc:qa`. Si viene
# calificado con OTRO plugin, no es asunto nuestro aunque el nombre coincida:
# un `otro-plugin:qa` no se bloquea porque nosotros tengamos `qa` apagado.
PLUGIN_NAME="$(grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*"' \
  "${HERE}/../.claude-plugin/plugin.json" 2>/dev/null \
  | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"

if [[ "$RAW" == *:* ]]; then
  [[ -n "$PLUGIN_NAME" && "${RAW%%:*}" != "$PLUGIN_NAME" ]] && exit 0
fi

# Un nombre sin calificar se trata como nuestro. Es la decisión conservadora: el
# skill los invoca calificados, así que dejar pasar un `qa` pelado sería un
# agujero en el gate, y el costo del caso raro —un agente homónimo del repo
# objetivo— es una invocación bloqueada con un mensaje que explica por qué.
AGENT="${RAW##*:}"

# Solo opinamos sobre los agentes de este plugin. Sin pipe a propósito: con
# `pipefail`, un `grep -q` corta la salida del productor y el pipeline entero da
# no-cero por SIGPIPE, así que el hook se iba por la puerta de "no es mío" y no
# bloqueaba nunca.
CONOCIDOS="$("$CONFIG" agents 2>/dev/null || true)"
ES_DEL_PLUGIN=0
while IFS= read -r a; do
  [[ "$a" == "$AGENT" ]] && ES_DEL_PLUGIN=1
done <<< "$CONOCIDOS"
[[ "$ES_DEL_PLUGIN" -eq 1 ]] || exit 0

if ! "$CONFIG" agent "$AGENT" >/dev/null 2>&1; then
  echo "BLOQUEADO: el agente '${AGENT}' está deshabilitado en este repo." >&2
  echo "Se configura en .claude/globant-sdlc.json, o desde el studio en Catálogo." >&2
  echo "No lo reemplaces haciendo vos su trabajo: si está apagado, es a propósito." >&2
  exit 2
fi

exit 0
