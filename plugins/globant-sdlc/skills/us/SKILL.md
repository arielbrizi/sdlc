---
name: us
description: Desarrolla una historia de usuario de punta a punta a partir de su ID (Jira, Azure DevOps o GitHub Issues), coordinando agentes de refinamiento, arquitectura, QA y seguridad hasta abrir el Pull Request. Usar SIEMPRE que el usuario mencione un ID de historia, ticket o issue y quiera implementarla, aunque no diga "us" explicitamente — por ejemplo "implementa GLOB-1234", "arranca con el ticket 8891", "haceme la historia #245".
---

# Ciclo de desarrollo de una historia de usuario

Ejecuta el ciclo completo desde el ID de la historia hasta un Pull Request en draft.
El humano no interviene durante el ciclo: **el PR es el gate**. Por eso cada fase deja
evidencia auditable y el flujo se aborta ante señales de riesgo en vez de improvisar.

## Invocación

```
/us GLOB-1234
/us 8891 --tracker ado
/us #245 --no-pr        # corre todo pero no abre el PR
```

## Fase 0 — Resolver la historia

Ejecutá el resolver, que detecta el tracker y normaliza la historia a un formato único:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/resolve-story.sh <ID> [tracker]
```

Devuelve la ruta a `.claude/run/<ID>/story.json` con el esquema canónico
(ver `references/trackers.md`). Si el script falla, **detenete y reportá** — no
inventes el contenido de la historia ni sigas con supuestos.

## Fase 1 — Refinamiento (circuit breaker)

Delegá en el subagente `refinamiento` pasándole `story.json`.

Este es el corte de seguridad más importante del flujo automático. Si el agente
devuelve `verdict: "BLOCKED"`:

1. Parás. No escribís una sola línea de código.
2. Comentás en el ticket las preguntas concretas que bloquean.
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

## Fase 3 — Implementación

1. Creá la branch desde la branch base configurada: `feature/<ID>-<slug>`
2. Implementá siguiendo `plan.md` y las reglas del repo (`CLAUDE.md`, `.claude/rules/`)
3. Escribí los tests **junto con** el código, no al final
4. Commits atómicos, con el ID de la historia en el mensaje

Respetá el stack y las convenciones que ya existen en el repo. Ante duda entre
dos formas, mirá cómo está resuelto un caso análogo en el codebase.

## Fase 4 — Verificación (en paralelo)

Delegá simultáneamente en:

- `qa` — cobertura de los criterios de aceptación, casos de borde, regresión
- `seguridad` — OWASP, secretos, authz, dependencias

Ninguno de los dos modifica código: reportan. Vos aplicás las correcciones.

Iterá hasta que ambos devuelvan `PASS`, con un **máximo de 3 ciclos**. Si al
tercero sigue habiendo hallazgos de severidad alta, abrí el PR igual pero
marcándolo con el hallazgo abierto y visible en la descripción. Nunca silencies
un hallazgo para poder cerrar el flujo.

## Fase 5 — Revisión adversarial

Delegá en `reviewer` con el diff completo. Su trabajo es buscar razones para
rechazar el cambio, no para aprobarlo. Aplicá lo que corresponda.

## Fase 6 — Pull Request

Abrí el PR **en draft**, con esta descripción:

```markdown
## <ID>: <título de la historia>
<link al ticket>

### Qué hace
<resumen en 2-3 líneas>

### Criterios de aceptación
- [x] AC1 — cubierto por `test_x`
- [x] AC2 — cubierto por `test_y`

### Decisiones de arquitectura
<lo relevante de plan.md>

### QA
<veredicto + cobertura>

### Seguridad
<veredicto + hallazgos abiertos, si los hay>

### Qué revisar con atención
<los 2-3 puntos donde el revisor humano debería mirar de verdad>

---
Generado por globant-sdlc. Los agentes no aprueban su propio trabajo:
este PR requiere revisión humana antes del merge.
```

Comentá en el ticket con el link al PR y movelo a "Code Review".

## Reglas transversales

- **Nunca** commitees a la branch base ni hagas force push
- **Nunca** toques secretos, `.env`, credenciales o config de infra
- Si el alcance real supera lo que describe la historia, paralo y reportalo:
  es señal de que la historia estaba mal dimensionada
- Todo el estado del run vive en `.claude/run/<ID>/` para que sea auditable

## Referencias

- `references/trackers.md` — esquema canónico de la historia y mapeo por tracker
