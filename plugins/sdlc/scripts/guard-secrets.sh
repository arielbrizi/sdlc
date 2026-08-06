#!/usr/bin/env bash
# Bloquea acceso a archivos que tipicamente contienen secretos.
# Exit 2 = bloquear la tool call.
set -euo pipefail

[[ -x "${CLAUDE_PLUGIN_ROOT:-}/scripts/record-hook.sh" ]] \
  && "${CLAUDE_PLUGIN_ROOT}/scripts/record-hook.sh" PreToolUse guard-secrets.sh || true

# Un único proceso parsea el payload y evalúa todos los patrones. Antes se
# lanzaban hasta nueve procesos grep adicionales por cada uso de una tool.
exec node "${CLAUDE_PLUGIN_ROOT}/scripts/guard-secrets.mjs"
