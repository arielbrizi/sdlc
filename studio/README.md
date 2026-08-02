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

## Cómo está organizado

El studio es un portal de catálogo, no una terminal. Tres capas fijas y cuatro
secciones:

| Capa | Qué tiene | Por qué está siempre visible |
|---|---|---|
| Barra global | plugin → repo, validar, recargar, tema, sesión de Claude | Dice contra qué estás trabajando; equivocarse de repo es el error caro |
| Barra de ejecución | origen de la historia, ID, Ejecutar, Detener, estado del run | Es la acción primaria de la herramienta: no se esconde detrás de una sección |
| Consola | eventos del run y el campo para escribirle a Claude | Se pliega a una línea cuando no hay nada que mirar y se abre sola al arrancar |

La consola se puede agrandar arrastrando su borde superior. El botón
**Ampliar** alterna entre el tamaño normal y casi toda la ventana, y la altura
elegida queda recordada. El separador también acepta `↑`, `↓`, `Home` y `End`
para ajustar la altura con teclado.

| Sección | Para qué |
|---|---|
| Ciclo | El mapa del skill `us` con el estado del run en vivo |
| Catálogo | Todo lo que aporta el plugin, en una tabla filtrable |
| Historia | Escribir una historia a mano, sin tracker |
| Configuración | Repositorio, branch base, permisos, herramientas y flags |

**Antes era una sola pantalla sin navegación**, con la configuración plegada
arriba y el formulario de historia compitiendo por el panel derecho. El costo no
era estético: no había forma de saber qué había en el plugin sin recorrer el
grafo nodo por nodo, y la configuración aparecía y desaparecía según el estado
de un plegable, así que el mismo control estaba en un lugar distinto cada vez.
Con secciones fijas, cada cosa tiene una ubicación y se llega igual siempre.

**Lo que se configura una vez vive en Configuración**, no en la vista principal:
se configura una vez y se ejecuta muchas. Si algo falla con el repositorio, el
studio te lleva ahí y marca la sección: un problema no puede quedar escondido en
una pantalla que no estás mirando.

**Cada sección abre con su encabezado en una línea**: el título dice dónde
estás y al lado va qué es esto. Apilado —y con un breadcrumb arriba que repetía
lo que ya marca la navegación— se comía 110px de alto en la vista donde el alto
es justamente lo que le falta al diagrama.

**Tema claro y oscuro**, con el del sistema como default y la elección
recordada. Y sin fuentes remotas: en una red corporativa una request a un CDN de
tipografías es una dependencia externa que no aporta nada.

El ciclo del skill `us` se dibuja como un grafo: la vía de fases a la izquierda
y colgando de cada una los componentes que intervienen ahí. Los hooks van en una
banda aparte, unida con línea punteada, porque no cuelgan de ninguna fase: corren
sobre cualquiera.

**Antes había una vía lateral además del grafo.** Se eliminó: era el mismo
diagrama dibujado dos veces, con su propio acumulador de estado, y esa
duplicación terminó mostrando la misma fase en curso de un lado y terminada del
otro. Hoy el estado de una fase vive en una sola variable y hay una sola vista.

Un clic en un nodo abre el panel de la derecha con lo que dijo el modelo en ese
componente, y ofrece abrir su archivo. **El panel aparece recién ahí**: vacío se
quedaba con un cuarto del ancho para no decir nada, y el mapa —que es lo que se
mira— quedaba apretado y con scroll horizontal. Se cierra con su botón y el
ancho vuelve al diagrama.

En el detalle de cada subagente, **Qué hace** sale de la `description` real de
su frontmatter y **Cómo trabaja** explica el concepto general de subagente. No
hay una tabla paralela de resúmenes: al agregar un agente nuevo, su descripción
aparece automáticamente en el mapa.

**El estado de cada caja va escrito además de pintado** —"listo", "en curso",
"bloqueado"— y la referencia va en la barra del título del mapa, que estaba
vacía a la derecha. Un diagrama donde el estado
vive solo en el color del borde deja afuera a quien no distingue esos colores, y
el estado es justamente lo que se viene a mirar durante un run.

**Mapa, barra de ejecución y consola reducen el mismo stream de eventos.** La
consola tiene un resumen fijo con el estado y la fase actuales: el log de abajo
es historial y no se usa como una segunda fuente de verdad. Terminar un turno de
Claude deja la sesión esperando; solo llegar efectivamente a Pull Request marca
el ciclo entero como completo. Un error o una detención deja la fase como
interrumpida, no como lista.

**Un bloqueo abre una acción, no solo un mensaje.** El studio identifica qué
subagente bloqueó, marca su fase real y muestra sus `blocking_questions` en un
diálogo que se abre solo. Si se cierra, queda una franja roja persistente arriba
y un botón dentro de la consola. Al responder, la decisión entra en la misma
sesión, se libera el bloqueo y mapa y consola pasan juntos a “retomando”. La
acción también sobrevive a un F5 porque se reconstruye desde el replay. El
studio espera a que termine el turno actual antes de publicar esa acción: nunca
muestra “acción requerida” mientras Claude todavía está ejecutando herramientas.
Cuando el turno termina sin bloqueo dice explícitamente “Sin acciones
pendientes · chat opcional”; tener el chat habilitado no significa que el ciclo
esté esperando una respuesta.

**Editar abre una ventana a pantalla completa**, con la configuración en una
columna y las instrucciones en la otra. Editar es una tarea enfocada y no tiene
por qué pelear por el ancho de un panel lateral: en el modal el texto arranca con
más de 400px de alto, contra los 48 que le quedaban embutido al costado. Se
cierra con `Esc` o con Cerrar, y avisa si hay cambios sin guardar.

## Recargar no pierde el run

El servidor guarda los eventos de cada run, así que un F5 se reengancha al
stream y el replay reconstruye fases, grafo, log y sesión. El panel recuerda
también lo que habías escrito en los controles.

Si el servidor se reinició, el run guardado ya no existe: el studio lo detecta y
arranca limpio en vez de quedarse esperando un stream que no va a llegar.

## Cada componente dice qué es

Todo lo que el panel muestra lleva su tipo: **Skill**, **Subagente**, **Hook**,
**Script**, **MCP server**, **Referencia**, **Manifiesto**. Al abrir un archivo,
el encabezado explica en una línea qué es esa clase de cosa, y el botón Glosario
lista las siete.

**Cada etiqueta abre lo que dice ser.** Suena obvio y es la parte que más fácil
se rompe: un nodo de hook que abre el `.sh` está mintiendo, porque el hook se
declara en `hooks/hooks.json` y el script es otro componente. Por eso el nodo de
un hook ofrece los dos por separado: "Abrir archivo" lleva a `hooks.json` y
"Abrir el script" al `.sh`.

Los nombres son los de Claude Code, no etiquetas del studio. Es deliberado: quien
use el panel un par de semanas tiene que poder leer la documentación oficial, o
escuchar "eso es un hook" en una reunión, y saber de qué se habla. Un vocabulario
propio sería más fácil de escribir y le enseñaría a la gente algo que no existe
afuera de esta herramienta.

Las explicaciones sí están escritas para alguien que recién arranca, y viven en
`KINDS`, dentro de `public/index.html`. Si agregás un tipo de componente,
agregalo ahí o va a aparecer sin etiqueta.

## El catálogo

El grafo responde "¿cómo corre esto?". El catálogo responde "¿qué hay acá
adentro?", que es la primera pregunta de cualquiera que abre el plugin por
primera vez y no tiene por qué recorrer un diagrama para contestarla.

Es una fila por archivo real —skills, referencias, subagentes, hooks, scripts,
MCP servers y el manifiesto— con su tipo, qué hace y los datos que importan de
cada uno: el modelo y el esfuerzo de un subagente, si es de solo lectura, el
matcher de un hook, si un script tiene bit de ejecución. Se filtra por tipo y se
busca por nombre, archivo o descripción. Un clic abre el editor.

Sale entero de `/api/plugin`, que es un escaneo genérico del directorio: no hay
que registrar nada acá al agregar un componente. Lo único que sí hay que
registrar es el **tipo**, en `KINDS`, o la fila aparece sin etiqueta.

Los problemas del escaneo —un script sin `chmod +x`, un manifest que no parsea—
se listan arriba de la tabla. Son exactamente los que rompen el plugin en
silencio.

**Cada subagente tiene un interruptor.** Apagarlo escribe
`.claude/globant-sdlc.json` en el repo objetivo en el acto —no hay un "guardar"
que se pueda olvidar— y es el mismo archivo que lee el hook que después impide
invocarlo.

Está en tres lugares y es la misma operación: en la fila del catálogo, en la
caja del agente dentro del mapa, y en el panel de detalle al seleccionarlo. Las
tres llaman a la misma función y redibujan las tres vistas, porque el modo de
falla de tener el control repetido es que una vista muestre habilitado lo que
otra apagó.

El del mapa es el que más se usa: apagar un agente es una decisión que se toma
mirando el ciclo, no leyendo una tabla. Vive dentro de la caja, con un área de
click más grande que el dibujo, y no selecciona el nodo al tocarlo. Un agente
apagado se sigue viendo, punteado y con la palabra "deshabilitado": sacarlo del
diagrama haría creer que el plugin no tiene esa fase.

Las fuentes de la fase de diseño —Storybook y Figma— se configuran en
Configuración y también se llega desde el encabezado del mapa o el detalle de
la fase 3. Para Figma se pega un único link al frame: el studio deriva
`file_key` y `node_id`, habilita el MCP remoto y prende `@ux`. Storybook queda
como opción separada porque responde otra pregunta: qué componentes ya existen
en código. Sus campos técnicos están plegados como opciones avanzadas.

## Editar

Un clic en cualquier nodo del grafo, o en cualquier fila del catálogo, abre el
archivo real.

La configuración del componente —el frontmatter— se muestra como campos con
nombre en criollo, la clave real al lado y una línea de qué significa. `model` y
`effort` son desplegables con los valores válidos, `maxTurns` es numérico y
`description` una caja de texto, porque es larga y es lo que Claude lee para
decidir si invoca ese componente.

Va en una columna a la izquierda y las instrucciones a la derecha: son dos cosas
distintas y se editan por separado. Un archivo sin frontmatter —un `.sh`, un
`.json`— no muestra esa columna, así que el texto se queda con todo el ancho.

`Cmd/Ctrl+S` guarda. La escritura preserva el modo del archivo, así que un
script no pierde su bit de ejecución al editarlo desde acá.

**Un cambio guardado no toma efecto en una sesión de Claude Code abierta.** Los
`SKILL.md` sí; `agents/`, `hooks/`, `.mcp.json` y `plugin.json` requieren
`/reload-plugins` o reiniciar.

## Escribir la historia acá, sin tracker

El selector de historia tiene tres modos. En `tracker`, pasás un ID y
la historia la lee el agente por MCP. En `escribir acá`, el selector abre
directamente un formulario mínimo: título, descripción y criterios de
aceptación. Desde ahí se ejecuta con un solo botón.

Al ejecutar, el studio la guarda en `.claude/run/<ID>/story.json` con el esquema
canónico —el mismo que produce Jira— y recién ahí lanza el run. El resolver la
encuentra en disco en la fase 0 y no consulta ningún MCP. De la fase 1 en
adelante nada distingue una historia escrita a mano de una que vino de un
tracker, así que no hubo que tocar ningún agente para soportarlo.

No hay biblioteca de historias, botones Guardar/Cargar ni campo de ID. Al
ejecutar se deriva automáticamente del título (`LOCAL-exportar-csv`) y se crea
el archivo técnico que consume el ciclo.

**No saltea el refinamiento.** `@refinamiento` la evalúa igual que a cualquier
otra y bloquea si los criterios faltan o no son verificables. Cuando eso pasa,
las preguntas aparecen en el centro de acciones para responderlas dentro de la
misma sesión.

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
claude -p --input-format stream-json --output-format stream-json --verbose \
       --plugin-dir <PLUGIN_DIR>
```

y le manda `/globant-sdlc:us <ID>` como primer mensaje por stdin.

Los dos detalles importan y no son obvios:

- **`--plugin-dir`**: sin esto la sesión corre en el repo objetivo sin el plugin
  cargado y `/globant-sdlc:us` no existe. Además hace que corra el plugin que
  hay **en disco**, que es el que el studio deja editar.
- **El nombre va calificado.** Las skills y los subagentes de un plugin se
  invocan con el nombre del plugin adelante: `/globant-sdlc:us`, no `/us`, y
  `globant-sdlc:qa`, no `qa`. Escribir el nombre suelto da
  `Unknown command: /us`. El studio lo arma a partir del `name` del manifest, y
  por eso el encabezado del grafo muestra el comando completo: es lo que hay
  que tipear. `stream-json` requiere
`--verbose`. Con historia escrita a mano el mensaje lleva además
`--tracker manual`.

El prompt va por stdin y no en la línea de comandos porque así la sesión queda
abierta: cuando el ciclo termina, el proceso sigue vivo esperando el próximo
mensaje. Eso es lo que convierte el panel de ejecución en una consola.

## Permisos

**Desde el studio no se puede aceptar un permiso.** El run corre con `claude -p`,
que no es interactivo: no hay dónde clickear "sí", así que todo lo que no esté
autorizado de antemano se deniega y el ciclo se queda a mitad de camino. Los
permisos se resuelven **antes** de ejecutar, de tres formas.

**1. El desplegable de permisos.** Es lo más rápido:

| Modo | Qué habilita |
|---|---|
| por defecto | Nada. Con `-p` equivale a denegar todo lo que requiera permiso. |
| `acceptEdits` | Escribir y editar archivos. **No** habilita `Bash`. |
| `bypassPermissions` | Todo, sin preguntar. |
| `plan` | Nada: analiza y propone, no ejecuta. |

El ciclo `/us` necesita `Bash` desde la fase 0 —`resolve-story.sh` es un script—,
así que `acceptEdits` **no alcanza**: es la causa más común de un run que se
frena diciendo "escritura denegada".

**2. El campo "Herramientas permitidas".** Se pasa a `--allowedTools` y es la
opción quirúrgica: `Bash,Write,Edit` habilita lo que el ciclo necesita sin
abrir todo. Acepta patrones: `Bash(git *)` permite solo git.

**3. `.claude/settings.json` en el repo objetivo.** Es la única que persiste y
se versiona, así que es la que conviene para un equipo:

```json
{
  "permissions": {
    "allow": ["Bash", "Write", "Edit"]
  }
}
```

Un apunte que importa acá: `bypassPermissions` **no desactiva los hooks del
plugin**. `guard-secrets.sh` y `guard-git.sh` son `PreToolUse` y siguen
corriendo, así que la política de compañía se mantiene aunque saltees los
permisos interactivos. Es exactamente la razón por la que esas reglas son hooks
y no prompts (ver `docs/decisiones.md`, D5).

## La consola

La consola vive abajo de todo, en todas las secciones: es el estado de la
sesión, no de una pantalla. Muestra el stream y tiene un campo para escribirle a
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

Dos correcciones sobre esa inferencia, que valen porque el modo de falla es
mostrar progreso que no ocurrió:

- **Un run bloqueado no avanza más.** El corte es terminal (D2), así que después
  de un `BLOCKED` el grafo se congela. Si no, el `blocked.md` que escribe el
  propio corte disparaba la regla de `Write` y el ciclo saltaba a
  "implementando" — justo lo contrario de lo que acababa de pasar.
- **Escribir en `.claude/run/<ID>/` no es implementar.** Ahí van `story.json`,
  `plan.md` y `blocked.md`: es la evidencia del run, no el código de la
  historia.

Los artefactos en disco además se cuentan solo si los escribió **este** run: el
directorio sobrevive entre corridas y un `qa.json` viejo encendería una fase que
todavía no ocurrió.

Esto es inferencia, no telemetría: si cambiás el flujo del skill, actualizá el
mapeo en `AGENT_PHASE` y `PHASES` dentro de `server.mjs`. Ojo que los subagentes
de un plugin llegan calificados (`globant-sdlc:qa`), así que el nombre se
desprefija antes de mapear. Para tracking exacto,
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
