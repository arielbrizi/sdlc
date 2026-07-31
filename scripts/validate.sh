#!/usr/bin/env bash
# Valida todos los manifiestos y componentes del marketplace.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Validando marketplace"
claude plugin validate . --strict

for plugin in plugins/*/; do
  echo "==> Validando ${plugin}"
  claude plugin validate "$plugin" --strict
done

echo "==> Sintaxis de scripts"
for f in plugins/*/scripts/*.sh scripts/*.sh; do
  bash -n "$f" && echo "  ok $f"
done

echo "==> Permisos de ejecucion"
for f in plugins/*/scripts/*.sh; do
  [[ -x "$f" ]] || { echo "  FALTA chmod +x: $f" >&2; exit 1; }
done

echo "Todo OK"
