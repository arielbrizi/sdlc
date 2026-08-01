# studio

Panel local para ver el plugin como sistema, editar cualquier componente en
disco, seguir un run fase por fase y seguir hablando con esa misma sesión cuando
termina.

```bash
node studio/server.mjs --repo ~/repos/mi-proyecto
# http://127.0.0.1:4477
```

| Flag | Default |
|---|---|
| `--plugin <dir>` | `plugins/globant-sdlc` |
| `--repo <dir>` | `$GLOBANT_TARGET_REPO`, o el cwd |
| `--port <n>` | `4477` |

## Por qué es una app local y no una web

El studio hace tres cosas que un navegador solo no puede: leer el plugin del
disco, escribir los cambios de vuelta, y ejecutar `claude`. Las tres necesitan un
proceso en la máquina del developer. Por eso es un servidor Node de 500 líneas
que sirve un HTML, no una aplicación desplegada.

Cero dependencias npm — solo built-ins de Node. En un entorno corporativo eso
significa que no hay supply chain que revisar antes de que el equipo lo use.

## Las tres vistas son la misma

El ciclo del skill `us` se dibuja como un diagrama de vía: siete estaciones
numeradas, unidas por un riel. Los componentes cuelgan de la estación donde
intervienen — `@seguridad` bajo Verificación, `resolve-story.sh` bajo Resolver.

Esa misma geometría es la que se ilumina durante un run. No hay una pestaña
"componentes" y otra "ejecución": el mapa **es** el tablero. Cuando `refinamiento`
bloquea una historia, la vía se corta ahí y se ve dónde.

Los hooks no aparecen en la vía porque no son secuenciales: corren en cualquier
momento, sobre cualquier fase. Van abajo, sin numerar, como enclavamiento.

## Cada componente dice qué es

Todo lo que el panel muestra lleva su tipo: **Skill**, **Subagente**, **Hook**,
**Script**, **MCP server**, **Referencia**, **Manifiesto**. Al abrir un archivo,
el encabezado explica en una línea qué es esa clase de cosa, y el botón Glosario
lista las siete.

Los nombres son los de Claude Code, no etiquetas del studio. Es deliberado: quien
use el panel un par de semanas tiene que poder leer la documentación oficial, o
escuchar "eso es un hook" en una reunión, y saber de qué se habla. Un vocabulario
propio sería más fácil de escribir y le enseñaría a la gente algo que no existe
afuera de esta herramienta.

Las explicaciones sí están escritas para alguien que recién arranca, y viven en
`KINDS`, dentro de `public/index.html`. Si agregás un tipo de componente,
agregalo ahí o va a aparecer sin etiqueta.

## Editar

Un clic en cualquier chip abre el archivo real. El frontmatter se muestra como
campos separados del cuerpo — `model`, `effort`, `maxTurns`, `disallowedTools`
son exactamente lo que se toca al calibrar un agente, y no tiene sentido que
haya que buscarlos dentro del texto.

`Cmd/Ctrl+S` guarda. La escritura preserva el modo del archivo, así que un
script no pierde su bit de ejecución al editarlo desde acá.

**Un cambio guardado no toma efecto en una sesión de Claude Code abierta.** Los
`SKILL.md` sí; `agents/`, `hooks/`, `.mcp.json` y `plugin.json` requieren
`/reload-plugins` o reiniciar.

## Escribir la historia acá, sin tracker

El selector **Fuente** de la consola tiene dos modos. En `tracker`, pasás un ID y
la historia la lee el agente por MCP. En `escrita acá`, la tipeás en la pestaña
**Historia**: título, descripción y criterios de aceptación, uno por línea.

Al ejecutar, el studio la guarda en `.claude/run/<ID>/story.json` con el esquema
canónico —el mismo que produce Jira— y recién ahí lanza el run. El resolver la
encuentra en disco en la fase 0 y no consulta ningún MCP. De la fase 1 en
adelante nada distingue una historia escrita a mano de una que vino de un
tracker, así que no hubo que tocar ningún agente para soportarlo.

El ID es opcional: si no lo ponés se deriva del título (`LOCAL-exportar-csv`).

**No saltea el refinamiento.** `@refinamiento` la evalúa igual que a cualquier
otra y bloquea si los criterios faltan o no son verificables. Cuando eso pasa,
las preguntas quedan en `.claude/run/<ID>/blocked.md`; el botón **Cargar** trae
la historia de vuelta al formulario para corregirla y volver a tirar el run.

Como no hay ticket al que escribirle, el PR es el único registro: en este modo la
descripción lleva los criterios completos en vez de un link.

## Sesión de Claude Code

El chip de la barra superior muestra si hay sesión iniciada, con qué método y
contra qué proveedor. Sale de `claude auth status --json`.

**El studio no guarda credenciales ni las pide por formulario.** Delega en el
CLI, que es donde ya viven: el botón Iniciar sesión levanta `claude auth login`,
muestra la URL del flujo OAuth como link y deja un campo para pegar el código si
el proceso lo pide. Cerrar sesión corre `claude auth logout`. Un token escrito en
un input web sería exactamente lo que `guard-secrets.sh` existe para impedir.

## Ejecutar

El botón Ejecutar corre, en el repo objetivo:

```
claude -p --input-format stream-json --output-format stream-json --verbose
```

y le manda `/us <ID>` como primer mensaje por stdin. `stream-json` requiere
`--verbose`. Con historia escrita a mano el mensaje lleva además
`--tracker manual`.

El prompt va por stdin y no en la línea de comandos porque así la sesión queda
abierta: cuando el ciclo termina, el proceso sigue vivo esperando el próximo
mensaje. Eso es lo que convierte el panel de ejecución en una consola.

## La consola

El panel Ejecución muestra el stream y abajo tiene un campo para escribirle a
Claude. Dos cosas que antes no se veían:

- **Cada herramienta que usa**, a medida que la usa: `Bash echo hola`,
  `Read src/api.ts`, `Task @seguridad`. Es lo que el run está haciendo ahora, no
  solo en qué fase va.
- **Tus propios mensajes**, marcados como `vos`, en la misma línea de tiempo.

La sesión no se cierra cuando el ciclo termina: queda en `Sesión abierta` y podés
seguir la conversación con todo el contexto del run —preguntarle por qué tomó una
decisión, pedirle que corrija algo, revisar el diff—. `Cerrar` la termina;
`Detener` mata el proceso.

Con **Solo consola, sin historia** la sesión se abre vacía, sin invocar `/us`:
sirve para usar el repo objetivo de forma interactiva sin arrancar el ciclo.

Ojo: mientras la sesión esté abierta hay un proceso `claude` vivo. El botón
Ejecutar queda deshabilitado hasta que la cierres — un run a la vez.

### Cómo se sabe en qué paso está

Por dos vías, porque ninguna sola alcanza:

**Inferencia sobre el stream** — da liveness inmediato:

| Evento | Fase |
|---|---|
| `Bash` con `resolve-story.sh` | 0 · Resolver |
| `Task` con `subagent_type` | la del agente (refinamiento → 1, qa/seguridad → 4, …) |
| `Write` / `Edit` / `MultiEdit` | 3 · Implementación |
| `Bash` con `gh pr create` | 6 · Pull Request |
| `"verdict": "BLOCKED"` en un resultado | corta en 1 |
| `blast_radius: high` | corta en 2 |

**Artefactos en disco** — confirman lo que la inferencia adivinó. El servidor
mira `.claude/run/<ID>/` y marca la fase cuando aparecen `story.json`, `plan.md`,
`qa.json`, `security.json`, `review.json`.

Esto es inferencia, no telemetría: si cambiás el flujo del skill, actualizá el
mapeo en `AGENT_PHASE` y `PHASES` dentro de `server.mjs`. Para tracking exacto,
la opción limpia es que el skill escriba un `phase.json` en el directorio del
run y que el studio lo lea.

## Seguridad

El endpoint de run ejecuta un binario en la máquina donde corre el servidor. Las
guardas puestas:

- Escucha **solo en `127.0.0.1`**. No exponerlo en una interfaz de red ni
  detrás de un proxy.
- El ID de historia se valida contra `^#?[A-Za-z0-9-]{1,40}$` y se pasa como
  argumento de `spawn`, sin shell. No hay inyección de comandos por ese campo.
- Las rutas de lectura y escritura se resuelven y se verifica que caigan dentro
  del directorio del plugin. `../../etc/passwd` devuelve 403.
- Solo se escriben `.md`, `.json`, `.sh`, `.yml`, `.yaml`.
- La historia escrita a mano es la única escritura fuera del plugin, y va
  siempre a `.claude/run/<ID>/story.json` del repo objetivo: el ID pasa por la
  misma validación y la ruta resuelta se verifica contra ese directorio.
- El studio nunca ve ni almacena credenciales: el login lo hace el CLI en su
  propio proceso, y el studio solo muestra su salida y le pasa lo que escribas
  en el campo de código.
- Lo que mandás por la consola se le escribe a `claude` por stdin, como un
  mensaje de usuario más. Vale lo mismo que la caja de "Flags extra": el
  proceso corre en tu máquina y hace lo que le pidas.

El campo "Flags extra" pasa lo que escribas directo al CLI. Es una puerta
abierta a propósito, para poder probar flags sin tocar el código — pero es tu
responsabilidad lo que pongas ahí.

## Limitaciones conocidas

- El parser de frontmatter cubre `clave: valor` y listas inline `[a, b]`. Si un
  archivo usa YAML anidado, la UI cae al editor de texto plano.
- No hay historial de runs entre reinicios del servidor: viven en memoria.
- La historia escrita a mano vive en `.claude/run/<ID>/`, que suele estar
  ignorado por git: es estado del run, no documentación del backlog. Si querés
  conservarla, versioná el directorio o copiala a otro lado.
- El editor es un textarea. Para este trabajo — prompts y JSON corto — alcanza;
  si en algún momento no alcanza, el archivo está en disco y tenés tu editor.
