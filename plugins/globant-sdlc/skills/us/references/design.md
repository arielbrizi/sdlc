# Fuentes de diseño: Storybook y Figma

Referencia de la fase 3. La lee el skill —o el agente `ux`— solo cuando el
proyecto tiene el diseño habilitado. Mientras esté apagado no ocupa contexto.

## Por qué las dos vienen apagadas

El plugin corre en repos de backend, de infraestructura y de librerías sin una
sola pantalla. Un agente de diseño ahí no tiene con qué trabajar: produce
hallazgos genéricos que nadie puede accionar, y esos hallazgos son peores que
no tener el agente, porque entrenan al equipo a ignorar la salida del ciclo.

Por eso el default es apagado y encenderlo es una decisión explícita del
proyecto que sí tiene frontend. Van por separado —`figma` y `storybook`— porque
son independientes: hay equipos con design system en Storybook y sin Figma, y
equipos con Figma y sin catálogo publicado.

## Configuración

En el repo objetivo, `.claude/globant-sdlc.json`:

```json
{
  "agents": {
    "ux": true
  },
  "figma": {
    "enabled": true,
    "url": "https://www.figma.com/design/AbCdEf123456/Producto?node-id=1234-5678"
  },
  "storybook": {
    "enabled": true,
    "dir": ".storybook",
    "url": "https://storybook.interno/globant-ui"
  }
}
```

| Clave | Qué es | Default |
|---|---|---|
| `agents.ux` | Si la fase 3 corre | `false` |
| `figma.enabled` | Si el agente consulta Figma; el studio lo activa al pegar un link | `false` |
| `figma.url` | Link al frame concreto de la feature | vacío |
| `figma.file_key` | Derivado de la URL, solo por compatibilidad | vacío |
| `figma.node_id` | Derivado de la URL, solo por compatibilidad | vacío |
| `storybook.enabled` | Si el agente lee el catálogo | `false` |
| `storybook.dir` | Directorio de configuración | `.storybook` |
| `storybook.url` | Storybook publicado, si lo hay | vacío |

En el studio no hay que completar esos campos técnicos. Seleccioná el frame en
Figma, usá **Copy link to selection**, pegá el link completo y guardá. El studio
extrae el archivo y el nodo, habilita Figma y prende `@ux`.

## Storybook

Se lee del repo, sin servicio externo. En orden de confiabilidad:

1. **`stories.json` de un Storybook publicado** (`<url>/index.json` en v7+,
   `<url>/stories.json` en v6). Es el índice real de lo que existe.
2. **Los archivos `*.stories.*`** del repo: dan los componentes, sus variantes y
   los args con los que se los usa de verdad.
3. **Los componentes sin story.** Existen y se usan, pero nada garantiza su
   contrato. Se pueden reusar; hay que marcarlos como riesgo.

Un componente que aparece en el índice pero no en el repo es de una dependencia
—una librería de design system publicada— y se reusa igual: es exactamente el
caso que justifica tener design system.

## Figma

Requiere el MCP remoto `figma`, declarado en el `.mcp.json` del plugin, contra
`https://mcp.figma.com/mcp`. No requiere Figma Desktop abierto. Cada developer
autoriza su cuenta por OAuth desde `/mcp`; el plugin no guarda tokens.

Consecuencias que hay que tener presentes:

- **Sin autorización o sin permiso sobre el archivo no hay contexto.** El agente
  lo reporta como `no disponible`, no inventa el diseño.
- **En CI no asumas una sesión OAuth.** Hasta que el equipo defina una identidad
  y política de autenticación no interactiva, dejá `figma.enabled` en `false` y
  apoyate en Storybook y el repo.

## Qué produce la fase

`design.md` en `.claude/run/<ID>/`, con el mismo estatus que `plan.md`: es
contrato para `desarrollador`, no sugerencia. Y `visual_acceptance`, que son
criterios verificables que `qa` traza igual que los de la historia.

Si el agente devuelve `verdict: "N_A"` —la historia no toca interfaz— no se
escribe `design.md` y el ciclo sigue. Es el caso esperado cuando alguien deja el
agente encendido en un repo mixto: no cuesta más que una invocación.
