#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

TMP_REPO="$(mktemp -d)"
trap 'rm -rf "$TMP_REPO"' EXIT
PLUGIN_ROOT="$PWD/plugins/sdlc"

git -C "$TMP_REPO" init -q
git -C "$TMP_REPO" config user.name Test
git -C "$TMP_REPO" config user.email test@example.com
printf '# Test\n' > "$TMP_REPO/README.md"
git -C "$TMP_REPO" add README.md
git -C "$TMP_REPO" commit -qm initial
git -C "$TMP_REPO" branch -M main

assert_blocked() {
  local label="$1" payload="$2" script="$3"
  if printf '%s\n' "$payload" | CLAUDE_PROJECT_DIR="$TMP_REPO" \
    CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$script" >/dev/null 2>&1; then
    echo "FAIL: debía bloquear: ${label}" >&2
    exit 1
  fi
}

assert_allowed() {
  local label="$1" payload="$2" script="$3"
  if ! printf '%s\n' "$payload" | CLAUDE_PROJECT_DIR="$TMP_REPO" \
    CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$script" >/dev/null 2>&1; then
    echo "FAIL: debía permitir: ${label}" >&2
    exit 1
  fi
}

OUT="$(CLAUDE_PROJECT_DIR="$TMP_REPO" CLAUDE_PLUGIN_OPTION_BASE_BRANCH=main \
  plugins/sdlc/scripts/prepare-branch.sh LOCAL-123 'Exportar CSV')"
[[ "$(git -C "$TMP_REPO" branch --show-current)" == "feature/LOCAL-123-exportar-csv" ]]
grep -q '"mode": "created"' <<<"$OUT"

# Reanudar el mismo ID es seguro e idempotente.
OUT="$(CLAUDE_PROJECT_DIR="$TMP_REPO" CLAUDE_PLUGIN_OPTION_BASE_BRANCH=main \
  plugins/sdlc/scripts/prepare-branch.sh LOCAL-123 'Exportar CSV')"
grep -q '"mode": "resumed"' <<<"$OUT"

# Pedir una ejecución nueva no pisa ni reutiliza la branch previa.
OUT="$(CLAUDE_PROJECT_DIR="$TMP_REPO" CLAUDE_PLUGIN_OPTION_BASE_BRANCH=main \
  SDLC_FORCE_NEW_BRANCH=1 plugins/sdlc/scripts/prepare-branch.sh LOCAL-123 'Exportar CSV')"
grep -q 'feature/LOCAL-123-exportar-csv-run-' <<<"$OUT"
git -C "$TMP_REPO" switch -q feature/LOCAL-123-exportar-csv

# Una feature como base y cambios del usuario deben bloquear el preflight.
if CLAUDE_PROJECT_DIR="$TMP_REPO" CLAUDE_PLUGIN_OPTION_BASE_BRANCH=feature/otra \
  plugins/sdlc/scripts/prepare-branch.sh LOCAL-456 Otra >/dev/null 2>&1; then
  echo 'FAIL: aceptó una feature como branch base' >&2
  exit 1
fi

printf 'cambio del usuario\n' > "$TMP_REPO/user.txt"
if CLAUDE_PROJECT_DIR="$TMP_REPO" CLAUDE_PLUGIN_OPTION_BASE_BRANCH=main \
  plugins/sdlc/scripts/prepare-branch.sh LOCAL-456 Otra >/dev/null 2>&1; then
  echo 'FAIL: aceptó un working tree con cambios del usuario' >&2
  exit 1
fi
rm "$TMP_REPO/user.txt"

# En un subproyecto de monorepo, los artefactos del run llevan prefijo desde el
# root Git y aun así no se confunden con cambios del usuario.
mkdir -p "$TMP_REPO/apps/web/.claude/run/SCOPE-1"
printf '%s\n' '{}' > "$TMP_REPO/apps/web/.claude/run/SCOPE-1/repo-context.json"
OUT="$(CLAUDE_PROJECT_DIR="$TMP_REPO/apps/web" CLAUDE_PLUGIN_OPTION_BASE_BRANCH=main \
  plugins/sdlc/scripts/prepare-branch.sh SCOPE-1 'Cambio web')"
grep -q '"branch": "feature/SCOPE-1-cambio-web"' <<<"$OUT"
git -C "$TMP_REPO" switch -q feature/LOCAL-123-exportar-csv

# repo_hint acepta el remoto esperado y bloquea repo equivocado o multirepo.
mkdir -p "$TMP_REPO/.claude/run/REPO-1"
printf '%s\n' '{"id":"REPO-1","tracker":"manual","title":"Repo","repo_hint":"test-repo"}' \
  > "$TMP_REPO/.claude/run/REPO-1/story.json"
printf '%s\n' '{"names":["test-repo"]}' > "$TMP_REPO/.claude/run/REPO-1/repo-context.json"
CLAUDE_PROJECT_DIR="$TMP_REPO" plugins/sdlc/scripts/validate-repo.sh REPO-1 >/dev/null
printf '%s\n' '{"id":"REPO-1","tracker":"manual","title":"Repo","repo_hint":"otro-repo"}' \
  > "$TMP_REPO/.claude/run/REPO-1/story.json"
if CLAUDE_PROJECT_DIR="$TMP_REPO" plugins/sdlc/scripts/validate-repo.sh REPO-1 >/dev/null 2>&1; then
  echo 'FAIL: aceptó un repo_hint que no coincide' >&2
  exit 1
fi
printf '%s\n' '{"id":"REPO-1","tracker":"manual","title":"Repo","repo_hint":"frontend,backend"}' \
  > "$TMP_REPO/.claude/run/REPO-1/story.json"
if CLAUDE_PROJECT_DIR="$TMP_REPO" plugins/sdlc/scripts/validate-repo.sh REPO-1 >/dev/null 2>&1; then
  echo 'FAIL: aceptó una historia multirepo en un run único' >&2
  exit 1
fi

# El hook permite commit en la feature preparada pero bloquea la base
# configurada aunque no sea una branch protegida convencional.
printf '%s\n' '{"tool_input":{"command":"git commit -m test"}}' \
  | (cd "$TMP_REPO" && CLAUDE_PLUGIN_OPTION_BASE_BRANCH=main \
      "$OLDPWD/plugins/sdlc/scripts/guard-git.sh")

if printf '%s\n' '{"tool_input":{"command":"git commit -m test"}}' \
  | (cd "$TMP_REPO" && CLAUDE_PLUGIN_OPTION_BASE_BRANCH=feature/LOCAL-123-exportar-csv \
      "$OLDPWD/plugins/sdlc/scripts/guard-git.sh") >/dev/null 2>&1; then
  echo 'FAIL: el hook permitió commit sobre la base configurada' >&2
  exit 1
fi

if printf '%s\n' '{"tool_input":{"command":"git push origin feature/LOCAL-123-exportar-csv"}}' \
  | (cd "$TMP_REPO" && CLAUDE_PLUGIN_OPTION_BASE_BRANCH=feature/LOCAL-123-exportar-csv \
      "$OLDPWD/plugins/sdlc/scripts/guard-git.sh") >/dev/null 2>&1; then
  echo 'FAIL: el hook permitió push sobre la base configurada' >&2
  exit 1
fi

GIT_GUARD="$PWD/plugins/sdlc/scripts/guard-git.sh"
SECRET_GUARD="$PWD/plugins/sdlc/scripts/guard-secrets.sh"

# Branches protegidas, refspecs y todas las variantes de force push.
assert_blocked 'push origin main' '{"tool_input":{"command":"git push origin main"}}' "$GIT_GUARD"
assert_blocked 'push -u origin main' '{"tool_input":{"command":"git push -u origin main"}}' "$GIT_GUARD"
assert_blocked 'push HEAD:main' '{"tool_input":{"command":"git push origin HEAD:main"}}' "$GIT_GUARD"
assert_blocked 'force-with-lease' '{"tool_input":{"command":"git push --force-with-lease origin feature/x"}}' "$GIT_GUARD"
assert_blocked 'short option cluster with force' '{"tool_input":{"command":"git push -uf origin feature/x"}}' "$GIT_GUARD"
assert_allowed 'push feature normal' '{"tool_input":{"command":"git push origin feature/LOCAL-123-exportar-csv"}}' "$GIT_GUARD"
git -C "$TMP_REPO" switch -q main
assert_blocked 'implicit push from protected branch' '{"tool_input":{"command":"git push"}}' "$GIT_GUARD"
git -C "$TMP_REPO" switch -q feature/LOCAL-123-exportar-csv

# Secretos reales bloquean por herramientas de archivo y Bash; nombres de
# código y plantillas públicas no generan falsos positivos.
assert_blocked 'Read .env' '{"tool_input":{"file_path":"/repo/.env"}}' "$SECRET_GUARD"
assert_blocked 'Bash cat .env' '{"tool_input":{"command":"cat /repo/.env"}}' "$SECRET_GUARD"
assert_blocked 'Bash git show .env' '{"tool_input":{"command":"git show HEAD:.env"}}' "$SECRET_GUARD"
assert_blocked 'credentials.json' '{"tool_input":{"file_path":"/repo/credentials.json"}}' "$SECRET_GUARD"
assert_allowed '.env.example' '{"tool_input":{"file_path":"/repo/.env.example"}}' "$SECRET_GUARD"
assert_allowed 'credentials service' '{"tool_input":{"file_path":"/repo/src/auth/credentials_service.ts"}}' "$SECRET_GUARD"
assert_allowed 'credentials test' '{"tool_input":{"file_path":"/repo/tests/test_credentials.py"}}' "$SECRET_GUARD"

# El resolver acepta la sintaxis que documenta el skill y rechaza traversal.
mkdir -p "$TMP_REPO/.claude/run/LOCAL-MANUAL"
printf '%s\n' '{"id":"LOCAL-MANUAL","tracker":"manual","title":"Manual"}' \
  > "$TMP_REPO/.claude/run/LOCAL-MANUAL/story.json"
CLAUDE_PROJECT_DIR="$TMP_REPO" plugins/sdlc/scripts/resolve-story.sh \
  LOCAL-MANUAL --tracker manual >/dev/null
if CLAUDE_PROJECT_DIR="$TMP_REPO" plugins/sdlc/scripts/resolve-story.sh \
  ../../escape --tracker jira >/dev/null 2>&1; then
  echo 'FAIL: el resolver aceptó un ID con traversal' >&2
  exit 1
fi

# El gate reconoce agentes calificados, deja pasar plugins ajenos y hooks.json
# cubre tanto el nombre histórico Task como Agent.
mkdir -p "$TMP_REPO/.claude"
printf '%s\n' '{"agents":{"qa":false}}' > "$TMP_REPO/.claude/sdlc.json"
assert_blocked 'qa deshabilitado' \
  '{"tool_input":{"subagent_type":"sdlc:qa"}}' \
  "$PWD/plugins/sdlc/scripts/guard-agents.sh"
assert_allowed 'qa de otro plugin' \
  '{"tool_input":{"subagent_type":"otro-plugin:qa"}}' \
  "$PWD/plugins/sdlc/scripts/guard-agents.sh"
node -e '
const hooks = require("./plugins/sdlc/hooks/hooks.json").hooks;
const matchers = hooks.PreToolUse.map(x => x.matcher);
if (!matchers.includes("Task|Agent")) process.exit(1);
if (!matchers.some(x => x.includes("Bash") && x.includes("MultiEdit"))) process.exit(1);
'

# SubagentStop registra el identificador y el veredicto cuando vienen en el
# payload, sin afirmar que siempre están disponibles.
mkdir -p "$TMP_REPO/.claude/run/LOGTEST"
export SDLC_STORY_ID=LOGTEST
export SDLC_STUDIO_RUN_ID=test-run
assert_allowed 'telemetría de guard-git' \
  '{"tool_input":{"command":"git status"}}' "$GIT_GUARD"
assert_allowed 'telemetría de guard-secrets' \
  '{"tool_input":{"file_path":"/repo/README.md"}}' "$SECRET_GUARD"
assert_allowed 'telemetría de guard-agents' \
  '{"tool_input":{"subagent_type":"otro-plugin:qa"}}' \
  "$PWD/plugins/sdlc/scripts/guard-agents.sh"
printf '%s\n' '{"tool_input":{"file_path":"/archivo/que/no/existe.js"}}' \
  | CLAUDE_PROJECT_DIR="$TMP_REPO" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    plugins/sdlc/scripts/format-and-lint.sh
printf '%s\n' '{"agent_id":"agent-123","last_assistant_message":"{\"verdict\":\"PASS\"}"}' \
  | CLAUDE_PROJECT_DIR="$TMP_REPO" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    plugins/sdlc/scripts/log-run.sh
grep -q 'agent=agent-123 verdict=PASS finished' \
  "$TMP_REPO/.claude/run/LOGTEST/timeline.log"
for hook_script in guard-git.sh guard-secrets.sh guard-agents.sh format-and-lint.sh log-run.sh; do
  grep -q "\"script\":\"${hook_script}\"" \
    "$TMP_REPO/.claude/run/LOGTEST/hook-events.jsonl"
done
unset SDLC_STORY_ID
unset SDLC_STUDIO_RUN_ID

echo 'Git policy OK'
