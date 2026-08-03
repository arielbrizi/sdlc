---
name: us
description: Desarrolla una historia de usuario de punta a punta a partir de su ID (Jira, Azure DevOps o GitHub Issues), coordinando agentes de refinamiento, arquitectura, diseno de interfaz, QA y seguridad hasta abrir el Pull Request. Usar SIEMPRE que el usuario mencione un ID de historia, ticket o issue y quiera implementarla, aunque no diga "us" explicitamente — por ejemplo "implementa GLOB-1234", "arranca con el ticket 8891", "haceme la historia #245".
---

# Ciclo de desarrollo de una historia de usuario

Ejecuta el ciclo completo desde el ID de la historia hasta un Pull Request en draft.
El humano no interviene durante el ciclo: **el PR es el gate**. Por eso cada fase deja
evidencia auditable y el flujo se aborta ante señales de riesgo en vez de improvisar.

## Invocación

```
/us GLOB-1234
/us 8891 --tracker ado
/us #245 --no-pr                        # corre todo pero no abre el PR
/us LOCAL-exportar-csv --tracker manual # historia escrita a mano, sin tracker
```

## Fase 0 — Resolver la historia y la configuración

Primero, leé qué tiene habilitado este repo:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/config.sh json
```

Guardá la salida en `.claude/run/<ID>/config.json`. Decide dos cosas:

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

Después ejecutá el resolver, que detecta el tracker y normaliza la historia a un
formato único:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/resolve-story.sh <ID> [tracker]
```

Devuelve la ruta a `.claude/run/<ID>/story.json` con el esquema canónico
(ver `references/trackers.md`). Si el script falla, **detenete y reportá** — no
inventes el contenido de la historia ni sigas con supuestos.

El campo `tracker` de la salida decide de dónde sale el contenido:

- **`jira` | `ado` | `github`** — leé la historia con el MCP que indica
  `mcp_hint` y escribí vos el `story.json` normalizado.
- **`manual`** — la historia ya está escrita en `story.json`: la tipeó el dev en
  el studio porque el equipo no integra con ningún tracker. **No consultes
  ningún MCP y no la reescribas**, leela y seguí.

Que una historia esté escrita a mano no la hace más confiable que una de Jira.
Pasa por refinamiento igual que las demás.

## Fase 1 — Refinamiento (circuit breaker)

Delegá en el subagente `refinamiento` pasándole `story.json`.

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

Delegá en `arquitectura`. Produce `plan.md` en el directorio del run con:
impacto en el codebase, diseño propuesto, archivos a tocar, contratos de API,
migraciones de datos y riesgos.

Si el plan declara `blast_radius: high` (migración de datos, cambio de contrato
público, tocar auth o billing), **el modo automático no aplica**: dejá el plan
escrito, no implementes y pedí revisión humana explícita.

## Fase 3 — Diseño de interfaz

**Solo si `agents.ux` está habilitado.** Viene apagada por defecto: el plugin
corre en repos de backend, y ahí un agente de diseño produce hallazgos genéricos
que nadie puede accionar.

Delegá en `ux`, pasándole `story.json`, `plan.md` y la sección de diseño de
`config.json`. Produce `design.md` en el directorio del run —escribilo vos con
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

Delegá en el subagente `desarrollador`, pasándole `plan.md` y `story.json`. Si
existe `design.md`, va también: es contrato, no sugerencia.

Es el único agente del ciclo que escribe código: branch `feature/<ID>-<slug>`,
implementación siguiendo el plan, tests junto con el código y commits atómicos
con el ID de la historia.

Si devuelve `verdict: "BLOCKED"`, no implementes vos lo que él frenó: sus
`blocking_questions` son las mismas que frenarían a cualquiera. Reportá al dev y
parás, igual que en la fase 1.

**Vos no escribís código en esta fase.** Tu trabajo es orquestar: pasarle el
contexto, leer su salida y encadenar la fase siguiente.

## Fase 5 — Verificación (en paralelo)

Delegá en `qa` y `seguridad` **en un solo mensaje, con las dos invocaciones en
el mismo bloque de tool calls**:

- `qa` — cobertura de los criterios de aceptación, casos de borde, regresión
- `seguridad` — OWASP, secretos, authz, dependencias

No alcanza con la intención de que corran juntos: dos invocaciones en mensajes
separados se ejecutan una después de la otra, y como no dependen entre sí eso
duplica el tiempo de la fase sin cambiar el resultado.

Ninguno de los dos modifica código: reportan. Las correcciones vuelven a
`desarrollador`, con los hallazgos de ambos en una sola pasada — invocarlo dos
veces seguidas le hace releer el mismo código para nada.

Iterá hasta que ambos devuelvan `PASS`, con un **máximo de 3 ciclos**. Si al
tercero sigue habiendo hallazgos de severidad alta, abrí el PR igual pero
marcándolo con el hallazgo abierto y visible en la descripción. Nunca silencies
un hallazgo para poder cerrar el flujo.

A partir del segundo ciclo, pasales el **diff de la corrección** y la lista de
hallazgos que motivaron el ciclo, no el repo entero. Re-auditar de cero código
que ya pasó no encuentra nada nuevo: lo único que cambió es lo que
`desarrollador` acaba de tocar. Un hallazgo que reaparece idéntico dos ciclos
seguidos no se reintenta un tercero — va abierto a la descripción del PR.

## Fase 6 — Revisión adversarial

Delegá en `reviewer` con el diff completo. Su trabajo es buscar razones para
rechazar el cambio, no para aprobarlo. Lo que corresponda corregir vuelve a
`desarrollador`, igual que en la fase 5.

## Fase 7 — Pull Request

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
Generado por globant-sdlc. Los agentes no aprueban su propio trabajo:
este PR requiere revisión humana antes del merge.
```

Comentá en el ticket con el link al PR y movelo a "Code Review".

Con tracker `manual` no hay ticket: salteá ese paso. El PR queda como único
registro de la historia, así que la descripción tiene que sostenerse sola —
copiá los criterios de aceptación completos en vez de referenciarlos.

## Reglas transversales

- **Nunca** commitees a la branch base ni hagas force push
- **Nunca** toques secretos, `.env`, credenciales o config de infra
- Si el alcance real supera lo que describe la historia, paralo y reportalo:
  es señal de que la historia estaba mal dimensionada
- Todo el estado del run vive en `.claude/run/<ID>/` para que sea auditable
- Con tracker `manual` no hay dónde escribir de vuelta: todo lo que iría a un
  comentario del ticket queda en `.claude/run/<ID>/`

## Referencias

- `references/trackers.md` — esquema canónico de la historia y mapeo por tracker
- `references/design.md` — configuración de Storybook y Figma para la fase 3
