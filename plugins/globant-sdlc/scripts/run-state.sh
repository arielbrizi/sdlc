#!/usr/bin/env bash
# run-state.sh — que parte del ciclo ya esta hecha para esta historia.
#
# Uso: run-state.sh <ID>
# Salida (stdout, JSON):
#   { "id", "run_dir", "exists", "base_branch", "current_branch",
#     "working_tree_clean", "artifacts", "agents_finished", "commits" }
#
# Existe porque el ciclo no tenia forma de saber si una fase ya habia corrido.
# Un run interrumpido y reanudado volvia a delegar la fase desde cero: en un run
# real eso costo once minutos de un `desarrollador` que releyo todo para
# descubrir que sus commits ya estaban hechos.
#
# El estado no se infiere del transcript, que se pierde al interrumpir: se lee
# del disco y de git, que sobreviven. `timeline.log` ya lo escribia `log-run.sh`
# en cada SubagentStop y no lo leia nadie.

set -uo pipefail

ID_RAW="${1:-}"
if [[ -z "$ID_RAW" ]]; then
  echo "error: falta el ID de la historia" >&2
  exit 1
fi

ID="${ID_RAW#\#}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
RUN_DIR="${PROJECT_DIR}/.claude/run/${ID}"

json_string() { printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

if [[ ! -d "$RUN_DIR" ]]; then
  printf '{ "id": "%s", "run_dir": "%s", "exists": false }\n' \
    "$(json_string "$ID")" "$(json_string "$RUN_DIR")"
  exit 0
fi

campo_run_json() {
  [[ -f "${RUN_DIR}/run.json" ]] || return 0
  grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "${RUN_DIR}/run.json" 2>/dev/null \
    | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

BASE_BRANCH="$(campo_run_json base_branch)"
STARTED_AT="$(campo_run_json started_at)"
CURRENT_BRANCH="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"

if git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  # `.claude/` es evidencia del run y config del plugin, no trabajo pendiente:
  # que este sin commitear no significa que el desarrollador dejo algo a medias.
  # Se filtra el directorio entero porque git reporta `?? .claude/` en una sola
  # linea cuando esta untracked, sin desglosar lo de adentro.
  SUCIO="$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null | grep -v '\.claude/' || true)"
  [[ -z "$SUCIO" ]] && LIMPIO=true || LIMPIO=false
else
  LIMPIO=false
fi

# Artefactos: la prueba mas dura de que una fase produjo algo.
artefacto() { [[ -s "${RUN_DIR}/$1" ]] && echo true || echo false; }

# Agentes cerrados con su veredicto, segun lo que dejo `log-run.sh`. Se conserva
# el ULTIMO cierre de cada agente: en los ciclos de correccion un mismo agente
# corre varias veces y lo que vale es como termino la ultima.
AGENTES=""
if [[ -f "${RUN_DIR}/timeline.log" ]]; then
  AGENTES="$(awk '
    match($0, /agent=[A-Za-z_-]+/) {
      agente = substr($0, RSTART + 6, RLENGTH - 6)
      veredicto = "unknown"
      if (match($0, /verdict=[A-Za-z_]+/)) {
        veredicto = substr($0, RSTART + 8, RLENGTH - 8)
      }
      ultimo[agente] = veredicto
      if (!(agente in orden)) { orden[agente] = ++n; nombre[n] = agente }
    }
    END { for (i = 1; i <= n; i++) printf "%s=%s\n", nombre[i], ultimo[nombre[i]] }
  ' "${RUN_DIR}/timeline.log" 2>/dev/null || true)"
fi

mapa_agentes() {
  local salida=""
  while IFS= read -r par; do
    [[ -z "$par" ]] && continue
    salida="${salida}${salida:+, }\"$(json_string "${par%%=*}")\": \"$(json_string "${par#*=}")\""
  done <<< "${1:-}"
  echo "$salida"
}

# Commits de esta historia. Se buscan por el ID en el mensaje —convencion del
# `desarrollador`— y no por fecha: la fecha del run no sobrevive a un rebase.
COMMITS=""
if git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  while IFS= read -r linea; do
    [[ -z "$linea" ]] && continue
    COMMITS="${COMMITS}${COMMITS:+, }\"$(json_string "$linea")\""
  done < <(git -C "$PROJECT_DIR" log --oneline --grep="$ID" -20 2>/dev/null || true)
fi

cat <<JSON
{
  "id": "$(json_string "$ID")",
  "run_dir": "$(json_string "$RUN_DIR")",
  "exists": true,
  "started_at": "$(json_string "$STARTED_AT")",
  "base_branch": "$(json_string "$BASE_BRANCH")",
  "current_branch": "$(json_string "$CURRENT_BRANCH")",
  "working_tree_clean": ${LIMPIO},
  "artifacts": {
    "story.json": $(artefacto story.json),
    "plan.md": $(artefacto plan.md),
    "design.md": $(artefacto design.md),
    "blocked.md": $(artefacto blocked.md)
  },
  "agents_finished": { $(mapa_agentes "$AGENTES") },
  "commits": [${COMMITS}]
}
JSON
