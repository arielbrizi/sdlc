# Trackers: esquema canónico y mapeo

El framework soporta Jira, Azure DevOps y GitHub Issues. Toda la lógica downstream
(agentes, prompts, PR) trabaja contra **un solo esquema**. Agregar un tracker nuevo
es agregar un mapeo acá, no tocar los agentes.

## Esquema canónico — `story.json`

```json
{
  "id": "GLOB-1234",
  "tracker": "jira",
  "url": "https://globant.atlassian.net/browse/GLOB-1234",
  "type": "story",
  "title": "Permitir exportar el reporte de consumo a CSV",
  "description": "<texto plano>",
  "acceptance_criteria": [
    "El botón Exportar aparece solo para usuarios con rol Analyst",
    "El CSV incluye las columnas fecha, usuario, consumo",
    "Un reporte de más de 50k filas se genera de forma asíncrona"
  ],
  "story_points": 5,
  "epic": "GLOB-1100",
  "labels": ["backend", "reporting"],
  "attachments": [{"name": "mockup.png", "url": "..."}],
  "linked_issues": [{"id": "GLOB-1180", "relation": "blocks"}],
  "repo_hint": "consumo-api",
  "raw": { }
}
```

`acceptance_criteria` es el campo crítico: si viene vacío o con ítems no
verificables, el agente de refinamiento bloquea el run.

## Detección automática del tracker

El resolver infiere el tracker por la forma del ID:

| Patrón | Tracker | Ejemplo |
|---|---|---|
| `^[A-Z][A-Z0-9]+-\d+$` | jira | `GLOB-1234` |
| `^#?\d+$` + remote de GitHub | github | `#245` |
| `^\d+$` sin remote de GitHub | ado | `8891` |
| `--tracker <x>` explícito | gana siempre | |

Cuando es ambiguo, usa `tracker_default` de la config del plugin.

## Mapeo de campos

### Jira

| Canónico | Origen |
|---|---|
| `title` | `fields.summary` |
| `description` | `fields.description` (ADF → texto plano) |
| `acceptance_criteria` | campo custom de AC; si no existe, se parsea la sección "Criterios de aceptación" de la descripción |
| `story_points` | campo custom de puntos |
| `epic` | `fields.parent.key` |

### Azure DevOps

| Canónico | Origen |
|---|---|
| `title` | `System.Title` |
| `description` | `System.Description` (HTML → texto plano) |
| `acceptance_criteria` | `Microsoft.VSTS.Common.AcceptanceCriteria` (HTML → lista) |
| `story_points` | `Microsoft.VSTS.Scheduling.StoryPoints` |
| `epic` | link padre de tipo Feature/Epic |

### GitHub Issues

| Canónico | Origen |
|---|---|
| `title` | `title` |
| `description` | `body` sin la sección de AC |
| `acceptance_criteria` | checklist `- [ ]` bajo el heading de AC |
| `story_points` | label `sp:N`, si existe |
| `epic` | issue linkeada de tipo epic o milestone |

GitHub es el más pobre en estructura: es donde más seguido va a saltar el
bloqueo por criterios de aceptación ausentes. Eso es información útil sobre el
proceso, no un problema del framework.

## Escritura de vuelta al tracker

El flujo escribe en el ticket en dos momentos: al bloquear por ambigüedad
(comentario con las preguntas) y al abrir el PR (comentario con el link +
transición de estado). Ninguna otra escritura está permitida — en particular,
el flujo **no cierra tickets**, porque el merge todavía no ocurrió.
