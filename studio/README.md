# studio

Panel local para ver el plugin como sistema, editar cualquier componente en
disco y seguir un run fase por fase.

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

## Ejecutar

El botón Ejecutar corre:

```
claude -p "/us <ID>" --output-format stream-json --verbose
```

en el repo objetivo, y consume el NDJSON que sale por stdout. `stream-json`
requiere `--verbose`.

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

El campo "Flags extra" pasa lo que escribas directo al CLI. Es una puerta
abierta a propósito, para poder probar flags sin tocar el código — pero es tu
responsabilidad lo que pongas ahí.

## Limitaciones conocidas

- El parser de frontmatter cubre `clave: valor` y listas inline `[a, b]`. Si un
  archivo usa YAML anidado, la UI cae al editor de texto plano.
- No hay historial de runs entre reinicios del servidor: viven en memoria.
- El editor es un textarea. Para este trabajo — prompts y JSON corto — alcanza;
  si en algún momento no alcanza, el archivo está en disco y tenés tu editor.
