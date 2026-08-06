# Trackers: esquema canónico y mapeo

El framework soporta Jira, Azure DevOps y GitHub Issues, más un modo `manual`
para equipos que no integran con ninguno. Toda la lógica downstream (agentes,
prompts, PR) trabaja contra **un solo esquema**. Agregar un tracker nuevo es
agregar un mapeo acá, no tocar los agentes.

## Esquema canónico — `story.json`

```json
{
  "id": "PROJ-1234",
  "tracker": "jira",
  "url": "https://example.atlassian.net/browse/PROJ-1234",
  "type": "story",
  "title": "Permitir exportar el reporte de consumo a CSV",
  "description": "<texto plano>",
  "acceptance_criteria": [
    "El botón Exportar aparece solo para usuarios con rol Analyst",
    "El CSV incluye las columnas fecha, usuario, consumo",
    "Un reporte de más de 50k filas se genera de forma asíncrona"
  ],
  "story_points": 5,
  "epic": "PROJ-1100",
  "labels": ["backend", "reporting"],
  "attachments": [{"name": "mockup.png", "url": "..."}],
  "linked_issues": [{"id": "PROJ-1180", "relation": "blocks"}],
  "repo_hint": "consumo-api",
  "raw": { }
}
```

`acceptance_criteria` es el campo crítico: si viene vacío o con ítems no
verificables, el agente de refinamiento bloquea el run.

`repo_hint` identifica un solo repositorio o subproyecto. Puede usar el nombre
del remoto (`consumo-api`) o el nombre del workspace dentro de un monorepo
(`checkout-web`). Una lista o un texto separado por comas significa que la
historia tiene alcance multirepo: el ciclo se detiene para dividirla, porque un
run automático es deliberadamente una branch y un PR.

## Detección automática del tracker

El resolver infiere el tracker por la forma del ID:

| Patrón | Tracker | Ejemplo |
|---|---|---|
| `--tracker <x>` explícito | gana siempre | |
| Ya existe un `story.json` con `"tracker": "manual"` | manual | |
| `^[A-Z][A-Z0-9]+-\d+$` | jira | `PROJ-1234` |
| `^#?\d+$` + remote de GitHub | github | `#245` |
| `^\d+$` sin remote de GitHub | ado | `8891` |

Cuando es ambiguo, usa `tracker_default` de la config del plugin.

La detección de `manual` va antes que las de forma del ID a propósito: un ID
escrito a mano puede parecerse a uno de Jira, y la historia que ya está en disco
siempre gana sobre lo que sugiera el nombre.

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

### Manual — historia escrita a mano

No hay mapeo: la historia se escribe directamente en el esquema canónico. El
studio la guarda en `.claude/run/<ID>/story.json` **antes** de arrancar el run
(pestaña Historia), y el resolver la encuentra ahí en la fase 0.

| Canónico | Origen |
|---|---|
| `id` | lo que escriba el dev, o derivado del título: `LOCAL-<slug>` |
| `title`, `description`, `acceptance_criteria` | los campos del formulario |
| `story_points`, `labels` | opcionales |
| `url`, `epic`, `repo_hint`, `attachments`, `linked_issues` | `null` o vacíos |
| `raw` | `{ "source": "studio", "authored_at": "<ISO8601>" }` |

Se escribe el esquema **completo**, con los campos que no aplican en `null` y no
una versión recortada: de la fase 1 en adelante nada distingue una historia
escrita a mano de una que vino de Jira, y esa indistinción es la que hace que no
haya que tocar ningún agente para soportar este modo.

También se puede crear el archivo a mano, sin studio. Lo único que el resolver
exige es que exista, que tenga `"tracker": "manual"` y un `title` no vacío.

Escribir la historia acá **no saltea el refinamiento**. Es tentador tratarla como
ya validada porque la escribió un humano hace treinta segundos, pero es
exactamente al revés: una historia tipeada al vuelo para arrancar un run tiene
más probabilidad de tener criterios flojos que una que pasó por un refinement.

## Escritura de vuelta al tracker

El flujo escribe en el ticket en dos momentos: al bloquear por ambigüedad
(comentario con las preguntas) y al abrir el PR (comentario con el link +
transición de estado). Ninguna otra escritura está permitida — en particular,
el flujo **no cierra tickets**, porque el merge todavía no ocurrió.

Con tracker `manual` no hay a dónde escribir. Las dos escrituras se vuelven
archivos en el directorio del run: las preguntas bloqueantes van a
`.claude/run/<ID>/blocked.md` y el PR queda como único registro de la historia.
Por eso, en este modo, la descripción del PR lleva los criterios de aceptación
completos en vez de un link.
