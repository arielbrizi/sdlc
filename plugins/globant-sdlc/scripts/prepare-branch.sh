#!/usr/bin/env bash
# Preflight determinístico: valida la base y prepara una branch exclusiva del run.
set -euo pipefail

ID="${1:-}"
TITLE="${2:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
BASE="${CLAUDE_PLUGIN_OPTION_BASE_BRANCH:-develop}"

fail() {
  echo "error: $1" >&2
  exit 2
}

[[ "$ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail "ID de historia inválido para una branch: ${ID}"
git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1 || fail "${PROJECT_DIR} no es un repositorio Git"

# Una feature como base mezcla historias y PRs. Los PR apilados requieren una
# decisión explícita fuera del ciclo automático.
[[ "$BASE" != feature/* ]] || fail "la branch base configurada '${BASE}' es una feature; elegí main, master, develop o release/*"

BASE_REF="$BASE"
if git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1; then
  git -C "$PROJECT_DIR" fetch --quiet origin "$BASE" \
    || fail "no se pudo actualizar origin/${BASE}; el modo automático no crea branches desde una base posiblemente obsoleta"
  BASE_REF="origin/${BASE}"
elif ! git -C "$PROJECT_DIR" rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null; then
  fail "la branch base '${BASE}' no existe localmente y el repo no tiene remote origin"
fi

# Los artefactos del plugin son estado auditable del run. Cualquier otro cambio
# pertenece al dev y no se pisa ni se arrastra a la nueva historia.
DIRTY="$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=all \
  | grep -vE '^.. \.claude/(run/|globant-sdlc\.json$)' || true)"
[[ -z "$DIRTY" ]] || fail "el working tree tiene cambios ajenos al run; guardalos o commitealos antes de continuar:\n${DIRTY}"

SLUG="$(printf '%s' "$TITLE" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g' \
  | cut -c1-48)"
BRANCH="feature/${ID}${SLUG:+-${SLUG}}"
CURRENT="$(git -C "$PROJECT_DIR" branch --show-current)"
MODE="created"

if [[ "$CURRENT" == "$BRANCH" ]]; then
  MODE="resumed"
elif git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git -C "$PROJECT_DIR" switch -q "$BRANCH"
  MODE="resumed"
elif git -C "$PROJECT_DIR" show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
  git -C "$PROJECT_DIR" switch -q --track "origin/${BRANCH}"
  MODE="resumed"
else
  git -C "$PROJECT_DIR" switch -q -c "$BRANCH" "$BASE_REF"
fi

cat <<JSON
{
  "base_branch": "${BASE}",
  "base_ref": "${BASE_REF}",
  "branch": "${BRANCH}",
  "mode": "${MODE}"
}
JSON
