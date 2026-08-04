---
name: us
description: Desarrolla una historia de usuario de punta a punta a partir de su ID (Jira, Azure DevOps o GitHub Issues), coordinando agentes de refinamiento, arquitectura, diseno de interfaz, QA y seguridad hasta abrir el Pull Request. Usar SIEMPRE que el usuario mencione un ID de historia, ticket o issue y quiera implementarla, aunque no diga "us" explicitamente — por ejemplo "implementa PROJ-1234", "arranca con el ticket 8891", "haceme la historia #245".
---

# Ciclo de desarrollo de una historia de usuario

Ejecuta el ciclo completo desde el ID de la historia hasta un Pull Request en draft.
El humano no interviene durante el ciclo: **el PR es el gate**. Por eso cada fase deja
evidencia auditable y el flujo se aborta ante señales de riesgo en vez de improvisar.

## Invocación

```
/us PROJ-1234
/us 8891 --tracker ado
/us #245 --no-pr                        # corre todo pero no abre el PR
/us LOCAL-exportar-csv --tracker manual # historia escrita a mano, sin tracker
```

Aceptá `--tracker <jira|ado|github|manual>` y `--no-pr` en cualquier orden
después del ID. `--no-pr` ejecuta todas las verificaciones y deja los artefactos
del run, pero no hace push, no abre ni actualiza PR y no modifica el ticket.

## Fase 0 — Resolver la historia y la configuración

Primero ejecutá el resolver. Acepta tanto el tracker posicional como
`--tracker <tracker>`:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/resolve-story.sh <ID> [--tracker <tracker>]
```

El resolver crea `.claude/run/<ID>/` y devuelve la ruta de `story.json` con el
esquema canónico (ver `references/trackers.md`). Si falla, **detenete y
reportá**: no inventes el contenido de la historia ni sigas con supuestos.

Validá inmediatamente que la historia pertenezca al repositorio y alcance
activos:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/validate-repo.sh <ID>
```

El script compara `repo_hint` con el nombre local, el remoto y el subproyecto
seleccionado. Si no coinciden, detenete: ejecutar sobre otro repo es una
modificación incorrecta, no una ambigüedad que el agente pueda resolver. Si la
historia declara varios repos también se detiene. El modo automático mantiene
el contrato **un run = una branch = un PR**; primero hay que dividir la historia
en alcances verificables por repositorio y ejecutar un run coordinado por cada
uno.

Después leé qué tiene habilitado este repo:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/config.sh json
```

Guardá la salida JSON, sin modificarla, en `.claude/run/<ID>/config.json`.
Decide dos cosas:

- **Qué agentes corren.** Un agente deshabilitado **no se invoca y no se
  reemplaza**: si el proyecto apagó `qa`, vos no hacés de QA. Saltás la fase,
  la dejás registrada como omitida y seguís. Hay un hook que además lo impide,
  así que intentarlo solo gasta un turno.
- **Si la fase 3 corre**, y con qué fuentes de diseño.

Dos casos que no son "saltear una fase":

- `desarrollador` deshabilitado — no hay ciclo posible. Reportá y terminá; no
  implementes vos la historia.
- `refinamiento` deshabilitado — el equipo apagó el circuit breaker. Corré
  igual, pero anotalo en la descripción del PR: quien revisa tiene que saber
  que la historia no pasó por ese control.

El campo `tracker` de la salida decide de dónde sale el contenido:

- **`jira` | `ado` | `github`** — leé la historia con el MCP que indica
  `mcp_hint` y escribí vos el `story.json` normalizado.
- **`manual`** — la historia ya está escrita en `story.json`: la tipeó el dev en
  el studio porque el equipo no integra con ningún tracker. **No consultes
  ningún MCP y no la reescribas**, leela y seguí.

Que una historia esté escrita a mano no la hace más confiable que una de Jira.
Pasa por refinamiento igual que las demás.

### Preflight Git obligatorio

Con `story.json` resuelto y antes de invocar cualquier subagente, prepará una
branch exclusiva para la historia:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/prepare-branch.sh <ID> "<título>"
```

El script valida que la base exista, rechaza una `feature/*` como base del modo
automático, preserva cambios ajenos al run y crea —o recupera—
`feature/<ID>-<slug>`. Si falla, **detenete y reportá**: no cambies de branch a
mano ni continúes sobre la branch actual. Los PR apilados son una decisión
explícita y quedan fuera del ciclo automático.

Guardá el JSON que devuelve como `.claude/run/<ID>/git.json`. Es el contrato de
branch para `desarrollador`: contiene `base_branch`, `base_ref`, `branch` y si el
run fue creado o reanudado.

Cuando Studio entrega un worktree aislado, trabajá únicamente en el cwd actual.
No vuelvas al checkout fuente indicado por `SDLC_SOURCE_REPO`: puede contener
cambios del desarrollador y existe solo como referencia de procedencia.

### Contrato de salidas de agentes

Cada subagente debe devolver exactamente un objeto JSON parseable con un campo
`verdict`. Guardá la respuesta completa en el artefacto correspondiente antes de
ramificar.

Si no parsea, falta `verdict` o usa un valor fuera del contrato, tratá primero el
caso como **cierre técnico incompleto**, no como una decisión humana. Reconciliá
los efectos persistidos (`git status`, `git diff`, `git log`, artefactos y tests)
y reinvocá una vez al mismo subagente con un pedido de cierre: debe inspeccionar
lo existente, completar solo lo estrictamente pendiente y devolver el JSON, sin
repetir la implementación. Nunca afirmes que no hubo commits sin mirar Git. Solo
si el segundo cierre vuelve a ser inválido detené el ciclo con un error técnico;
no inventes preguntas bloqueantes ni pidas aprobación para continuar.

## Fase 1 — Refinamiento (circuit breaker)

Delegá en el subagente `refinamiento` pasándole `story.json`.

Guardá su salida validada en `refinement.json`.

Este es el corte de seguridad más importante del flujo automático. Si el agente
devuelve `verdict: "BLOCKED"`:

1. Parás. No escribís una sola línea de código.
2. Comentás en el ticket las preguntas concretas que bloquean. Si el tracker es
   `manual` no hay ticket donde comentar: escribilas en
   `.claude/run/<ID>/blocked.md`, que es lo que el dev va a leer para corregir
   la historia en el studio y volver a tirar el run.
3. Reportás al dev qué falta.

Un ciclo de 40 minutos sobre una historia ambigua produce código que hay que tirar.
Frenar acá es el comportamiento correcto, no una falla.

## Fase 2 — Arquitectura

Delegá en `arquitectura`, pasándole `story.json`, `config.json`, `git.json` y
`repo-context.json`.
Guardá su JSON en `architecture.json` y escribí el campo `plan_md` como
`plan.md`. El agente no escribe archivos. El plan contiene:
impacto en el codebase, diseño propuesto, archivos a tocar, contratos de API,
migraciones de datos y riesgos.

Si devuelve `BLOCKED`, tratá sus `blocking_questions` como las de refinamiento.
Si declara `blast_radius: high` (migración de datos, cambio de contrato
público, tocar auth o billing), **el modo automático no aplica**: dejá el plan
escrito, no implementes y pedí revisión humana explícita.

## Fase 3 — Diseño de interfaz

**Solo si `agents.ux` está habilitado.** Viene apagada por defecto: el plugin
corre en repos de backend, y ahí un agente de diseño produce hallazgos genéricos
que nadie puede accionar.

Delegá en `ux`, pasándole `story.json`, `plan.md`, `repo-context.json` y la
sección de diseño de `config.json`. Guardá su JSON en `design.json`. Produce `design.md` en el
directorio del run —escribilo vos con
el contenido que devuelve en `design_md`— con qué componentes del design system
reusar, qué falta, tokens, estados y criterios visuales verificables.

Para Figma, la entrada principal es `figma.url`: apunta al frame concreto de la
feature y el MCP remoto lo abre directamente. `file_key` y `node_id` son campos
derivados para compatibilidad; no se los pidas al dev ni prefieras esos campos
sobre la URL.

Corre **antes** de implementar y no después: el costo caro de no tener diseño en
el ciclo no es una pantalla fea, es un componente nuevo escrito desde cero
cuando ya existía uno equivalente.

Si devuelve `verdict: "N_A"` la historia no toca interfaz: no escribas
`design.md` y seguí. Si devuelve `BLOCKED`, tratalo como el corte de la fase 1.

Ver `references/design.md` para cómo se configuran Storybook y Figma, y qué pasa
cuando una de las dos fuentes no está disponible.

## Fase 4 — Implementación

Delegá en el subagente `desarrollador`, pasándole `plan.md`, `story.json`,
`git.json` y `repo-context.json`. Si existe `design.md`, va también: es
contrato, no sugerencia.

Es el único agente del ciclo que escribe código. La branch
`feature/<ID>-<slug>` ya fue preparada en el preflight: el agente debe verificar
que sigue parado ahí, implementar siguiendo el plan, agregar tests junto con el
código y hacer commits atómicos con el ID de la historia.

Guardá cada salida validada del agente en `implementation.json`, reemplazando la
anterior; el historial de commits queda en Git.

Si devuelve `verdict: "BLOCKED"`, no implementes vos lo que él frenó: sus
`blocking_questions` son las mismas que frenarían a cualquiera. Reportá al dev y
parás, igual que en la fase 1.

**Vos no escribís código en esta fase.** Tu trabajo es orquestar: pasarle el
contexto, leer su salida y encadenar la fase siguiente.

## Fase 5 — Verificación (en paralelo)

Delegá simultáneamente, pasándoles `story.json`, `plan.md`, `git.json`,
`repo-context.json`, el diff
completo contra `base_ref` y, si existe, `design.md`, en:

- `qa` — cobertura de los criterios de aceptación, casos de borde, regresión
- `seguridad` — OWASP, secretos, authz, dependencias

Guardá las salidas en `qa.json` y `security.json`. Ninguno modifica código:
reportan. Las correcciones vuelven a
`desarrollador`, con los hallazgos de ambos en una sola pasada — invocarlo dos
veces seguidas le hace releer el mismo código para nada.

Las fases 5 y 6 forman un único loop de verificación. Después de cualquier
corrección del desarrollador, volvé a correr **QA y seguridad antes del
reviewer**: el último código del PR siempre tiene que haber sido auditado.

Hay un máximo total de **3 rondas de corrección** entre implementación,
verificación y review. Si después de la tercera queda un hallazgo `critical` o
`high`, un criterio sin cubrir o un cambio bloqueante del reviewer, detené el
ciclo y escribí `blocked.md`; no abras un PR que el propio flujo considera
inseguro. Hallazgos `medium` o `low` pueden quedar visibles en el PR.

## Fase 6 — Revisión adversarial

Delegá en `reviewer` con `story.json`, `plan.md`, `repo-context.json`, los JSON de QA y seguridad y
el diff completo contra `base_ref`. Guardá su salida en `review.json`. Su
trabajo es buscar razones para
rechazar el cambio, no para aprobarlo. Lo que corresponda corregir vuelve a
`desarrollador`. Después repetí QA, seguridad y reviewer, respetando el máximo
global de 3 rondas.

## Fase 7 — Pull Request

Si se invocó con `--no-pr`, terminá acá reportando las verificaciones y la
branch local. No hagas push ni escrituras remotas.

Abrí el PR **en draft**, con esta descripción:

```markdown
## <ID>: <título de la historia>
<link al ticket — omitilo si el tracker es `manual`, no hay a dónde apuntar>

### Qué hace
<resumen en 2-3 líneas>

### Criterios de aceptación
- [x] AC1 — cubierto por `test_x`
- [x] AC2 — cubierto por `test_y`

### Decisiones de arquitectura
<lo relevante de plan.md>

### Diseño
<lo relevante de design.md — omitilo si la fase 3 no corrió>

### QA
<veredicto + cobertura>

### Seguridad
<veredicto + hallazgos abiertos, si los hay>

### Qué revisar con atención
<los 2-3 puntos donde el revisor humano debería mirar de verdad>

### Fases omitidas
<los agentes deshabilitados en este repo, si los hay, y qué control se perdió
con cada uno. Omitilo si corrieron todos.>

---
Generado por sdlc. Los agentes no aprueban su propio trabajo:
este PR requiere revisión humana antes del merge.
```

Comentá en el ticket con el link al PR y movelo a "Code Review". Recién después
de confirmar ambas operaciones reportá `ciclo completo` y el link del PR; el
Studio usa esa salida como evidencia de cierre.

Con tracker `manual` no hay ticket: salteá ese paso. El PR queda como único
registro de la historia, así que la descripción tiene que sostenerse sola —
copiá los criterios de aceptación completos en vez de referenciarlos.

## Reglas transversales

- **Nunca** commitees a la branch base ni hagas force push
- **Nunca** reutilices la branch o el PR de otra historia. Antes de pushear,
  verificá la base/default branch y buscá un PR existente para el head actual.
- **Nunca** toques secretos, `.env`, credenciales o config de infra
- Si el alcance real supera lo que describe la historia, paralo y reportalo:
  es señal de que la historia estaba mal dimensionada
- Todo el estado del run vive en `.claude/run/<ID>/` para que sea auditable
- La sesión principal persiste las salidas de agentes; un auditor nunca escribe
  su propio veredicto ni su contrato
- Con tracker `manual` no hay dónde escribir de vuelta: todo lo que iría a un
  comentario del ticket queda en `.claude/run/<ID>/`

## Referencias

- `references/trackers.md` — esquema canónico de la historia y mapeo por tracker
- `references/design.md` — configuración de Storybook y Figma para la fase 3
