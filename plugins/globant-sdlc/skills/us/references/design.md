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
    "file_key": "AbCdEf123456",
    "node_id": "1234:5678"
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
| `figma.enabled` | Si el agente consulta Figma | `false` |
| `figma.file_key` | El `file_key` del archivo, de la URL de Figma | vacío |
| `figma.node_id` | Nodo raíz del feature, si el archivo es grande | vacío |
| `storybook.enabled` | Si el agente lee el catálogo | `false` |
| `storybook.dir` | Directorio de configuración | `.storybook` |
| `storybook.url` | Storybook publicado, si lo hay | vacío |

El `file_key` sale de la URL: `figma.com/design/<file_key>/<nombre>`. El
`node_id` sale del parámetro `node-id` cuando seleccionás un frame.

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

Requiere el MCP `figma`, declarado en el `.mcp.json` del plugin. Es el servidor
de Dev Mode que expone Figma Desktop en `http://127.0.0.1:3845/mcp`: corre en la
máquina del developer, con la sesión de Figma que ya tiene abierta, así que el
plugin no maneja tokens de Figma.

Consecuencias que hay que tener presentes:

- **Sin Figma Desktop abierto no hay MCP.** El agente lo va a reportar como
  `no disponible`, no como error del run. Con `storybook` habilitado el trabajo
  se hace igual, con menos precisión sobre la intención del diseño.
- **En CI no hay Figma.** Un run automático en un runner no tiene sesión ni app
  de escritorio. Ahí conviene dejar `figma.enabled` en `false` y apoyarse en
  Storybook, que sí es del repo.

## Qué produce la fase

`design.md` en `.claude/run/<ID>/`, con el mismo estatus que `plan.md`: es
contrato para `desarrollador`, no sugerencia. Y `visual_acceptance`, que son
criterios verificables que `qa` traza igual que los de la historia.

Si el agente devuelve `verdict: "N_A"` —la historia no toca interfaz— no se
escribe `design.md` y el ciclo sigue. Es el caso esperado cuando alguien deja el
agente encendido en un repo mixto: no cuesta más que una invocación.
