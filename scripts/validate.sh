#!/usr/bin/env bash
# Valida todos los manifiestos y componentes del marketplace.
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob

echo "==> Validando marketplace"
claude plugin validate . --strict

for plugin in plugins/*/; do
  echo "==> Validando ${plugin}"
  claude plugin validate "$plugin" --strict
done

echo "==> Sintaxis de scripts"
for f in plugins/*/scripts/*.sh scripts/*.sh; do
  if ! bash -n "$f"; then
    echo "  SINTAXIS INVALIDA: $f" >&2
    exit 1
  fi
  echo "  ok $f"
done

echo "==> Permisos de ejecucion"
for f in plugins/*/scripts/*.sh; do
  [[ -x "$f" ]] || { echo "  FALTA chmod +x: $f" >&2; exit 1; }
done

echo "==> Contratos de agentes"
for f in plugins/*/agents/*.md; do
  grep -q '"verdict"' "$f" \
    || { echo "  FALTA contrato JSON con verdict: $f" >&2; exit 1; }
  if [[ "$(basename "$f")" != "desarrollador.md" ]]; then
    grep -Eq '^disallowedTools:.*Write.*Edit' "$f" \
      || { echo "  AUDITOR puede escribir con Write/Edit: $f" >&2; exit 1; }
  fi
  echo "  ok $f"
done

echo "==> JSON del plugin"
for f in .claude-plugin/marketplace.json plugins/*/.claude-plugin/plugin.json \
  plugins/*/.mcp.json plugins/*/hooks/hooks.json; do
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$f" \
    || { echo "  JSON INVALIDO: $f" >&2; exit 1; }
  echo "  ok $f"
done

echo "==> Tests del Studio"
node --check studio/server.mjs
node --check studio/run-signals.mjs
node --test studio/*.test.mjs

echo "==> Tests de política Git"
./scripts/test-git-policy.sh

echo "Todo OK"
