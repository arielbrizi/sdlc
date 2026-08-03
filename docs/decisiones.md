# Decisiones de diseño

Registro de por qué el framework es como es. Se actualiza cuando una decisión
cambia, no cuando se implementa algo.

## D1 — El PR es el gate, no el flujo

**Contexto.** El objetivo es full auto: el dev pasa un ID y el ciclo llega al PR
sin frenar.

**Decisión.** El ciclo corre sin gates intermedios, pero el PR se abre en draft
con la autoevaluación de cada agente y una sección "qué revisar con atención".
El merge sigue siendo humano.

**Por qué.** Los gates intermedios matan el valor del modo automático: si el dev
tiene que estar presente en tres momentos, no delegó nada. Mover el único gate al
final conserva la autonomía sin eliminar la supervisión. El draft y la sección de
foco existen para evitar el rubber-stamp: un PR que declara dónde tiene menos
confianza se revisa mejor que uno que se presenta terminado.

## D2 — Condiciones de aborto automático

**Contexto.** Sin gates intermedios, el flujo necesita poder frenarse solo.

**Decisión.** El run aborta automáticamente cuando:
1. `refinamiento` devuelve `BLOCKED` — la historia no es implementable
2. `arquitectura` declara `blast_radius: high` — auth, pagos, PII, migración
   destructiva o contrato público
3. una salida de agente no cumple su contrato JSON
4. después de tres rondas siguen abiertos hallazgos críticos/altos, criterios
   sin cubrir o cambios bloqueantes del reviewer

**Por qué.** El costo del modo automático no es el bug detectado tarde: es gastar
el ciclo completo sobre supuestos equivocados, o aplicar autonomía donde
equivocarse es caro. Full auto para el 80% de las historias; el 20% restante
pide humano por diseño.

## D3 — Quien audita no corrige

**Decisión.** Todos los auditores tienen `Write` y `Edit` deshabilitados. La
sesión principal persiste sus JSON y sólo `desarrollador` corrige código.
Arquitectura, UX y reviewer tampoco tienen Bash. QA y seguridad lo necesitan
para correr suites y scanners, de modo que en ellos la prohibición de usar Bash
para escribir es contractual y está acotada por los hooks de secretos y Git.

**Por qué.** Un agente que corrige lo que audita se aprueba solo. Donde el
runtime permite separar herramientas de lectura y escritura, la separación es
estructural; donde Bash es indispensable para verificar, la limitación se
declara con precisión en vez de prometer una garantía inexistente.

## D4 — Adaptación de trackers en el borde

**Contexto.** Hay que soportar Jira, Azure DevOps y GitHub Issues.

**Decisión.** `resolve-story.sh` detecta el tracker y normaliza a un `story.json`
canónico. Los agentes solo conocen ese esquema.

**Por qué.** Si los agentes conocieran a Jira, sumar un tracker obligaría a tocar
todo el ciclo. Con la adaptación en el borde, sumar uno es agregar un mapeo.

**Evidencia.** El modo `manual` (D8) se sumó sin tocar un solo agente.

## D5 — Política en hooks, criterio en agentes

**Decisión.** Secretos, git destructivo, formateo y auditoría son hooks. Todo lo
que requiera juicio es agente.

**Por qué.** Un hook ejecuta código: no puede alucinar ni ser persuadido. Un
prompt es una sugerencia fuerte. Las reglas que nunca deberían poder saltearse
no pueden depender de que el modelo las recuerde en el turno 40.

## D6 — Distribución como plugin, no `.claude/` suelto

**Decisión.** Distribuir como plugin desde este repositorio, usando el mecanismo
que Claude Code denomina `marketplace`, en vez de copiar un `.claude/` en cada
repo. En este contexto `marketplace` es solamente el índice técnico que permite
instalar el plugin: no existe ni se consulta un catálogo corporativo de Globant.

**Por qué.** Versionado, actualización centralizada y un solo lugar donde
corregir un agente. El costo es el namespacing de las skills
(`/globant-sdlc:us`) y un paso de instalación. A escala de varios squads, el
costo de mantener copias divergentes es mucho mayor.

## Pendientes de decidir

- Modelo por agente: hoy `opus` para arquitectura y reviewer, `sonnet` para el
  resto. Falta medir si `sonnet` alcanza para arquitectura en historias chicas.
- Qué pasa cuando una historia toca más de un repo.
- Si `.claude/run/` se versiona (evidencia para compliance) o se ignora.

## D7 — El studio es una app local, no una web desplegada

**Contexto.** Hace falta ver el plugin como sistema, editar componentes y seguir
un run en vivo.

**Decisión.** Servidor Node local sin dependencias npm, que sirve un HTML. No se
despliega en ningún lado y escucha solo en `127.0.0.1`.

**Por qué.** Las tres funciones necesitan un proceso en la máquina del developer:
leer el plugin del disco, escribir los cambios de vuelta y ejecutar `claude`. Un
navegador solo no puede hacer ninguna. Cero dependencias npm además evita la
revisión de supply chain antes de que el equipo lo use.

**Costo.** El studio duplica el modelo de fases del skill `us` (ver CLAUDE.md).
Si aparece un segundo skill orquestador, ese mapeo se mueve al SKILL.md.

## D8 — La historia se puede escribir a mano

**Contexto.** El framework asumía que toda historia vive en un tracker. Eso deja
afuera a los equipos que no integran con ninguno, y también al caso de probar el
ciclo antes de tener las credenciales del MCP resueltas — que en la práctica es
el primer contacto de casi todo el mundo con el plugin.

**Decisión.** Un cuarto tracker, `manual`. La historia se escribe en el studio,
que la guarda en `.claude/run/<ID>/story.json` con el **esquema canónico
completo** antes de arrancar el run. `resolve-story.sh` la detecta en disco y
devuelve `tracker: manual` con la instrucción de no consultar ningún MCP.

**Por qué así.** La alternativa era un flag que le pasara título y criterios al
skill por prompt. Se descartó: obligaría a cada agente downstream a contemplar
"y si la historia no vino de un tracker". Escribiendo el mismo `story.json` que
produciría Jira, la fase 0 absorbe toda la diferencia y de la 1 en adelante no
hay ningún caso especial. Es la misma lógica de D4, aplicada al borde de que no
haya borde.

**Lo que no cambia.** `@refinamiento` evalúa la historia manual igual que a
cualquier otra. La tentación era saltear el gate —la escribió un humano hace
treinta segundos, ¿qué va a preguntar?— pero es al revés: una historia tipeada al
vuelo para arrancar un run tiene más chance de tener criterios flojos que una que
pasó por un refinement. Saltear el circuit breaker acá lo volvería opcional en
todos lados, que es exactamente lo que D2 evita.

**Costo.** No hay tracker al que escribirle de vuelta. Las dos escrituras que el
flujo hacía sobre el ticket se vuelven archivos del run: las preguntas
bloqueantes a `blocked.md`, y el PR pasa a ser el único registro de la historia
—por eso en este modo lleva los criterios completos en vez de un link.

## D9 — La sesión del run queda abierta

**Contexto.** El studio corría `claude -p "/us <ID>"` y el proceso moría al
terminar. Si el run se bloqueaba en refinamiento, o tomaba una decisión rara en
arquitectura, no había forma de preguntarle nada: el contexto se iba con el
proceso. La única salida era abrir una terminal aparte y empezar de cero.

**Decisión.** El prompt pasa a mandarse por stdin con
`--input-format stream-json`, que mantiene el proceso vivo después de responder.
El panel de ejecución gana un campo de mensaje: cuando el ciclo termina, la
sesión queda abierta y el dev sigue la conversación con todo el contexto del run.
También se puede abrir una sesión vacía, sin invocar `/us`.

**Además.** El stream emite un evento por cada llamada a herramienta, así que el
log muestra qué está haciendo el run —`Bash`, `Read`, `Task @seguridad`— y no
solo en qué fase va. Era información que ya pasaba por stdout y se descartaba.

**Por qué.** El PR sigue siendo el gate (D1) y esto no lo toca: no agrega un paso
ni pide intervención durante el ciclo. Lo que agrega es poder interrogar el run
*después*, que es justo cuando aparecen las preguntas. Un flujo automático que no
se puede interrogar cuando falla obliga a reconstruir el contexto a mano, y ahí
se pierde más tiempo del que el modo automático ahorró.

**Costo.** Mientras la sesión esté abierta hay un proceso vivo, así que el studio
maneja un run a la vez y hay que cerrarla explícitamente. Es aceptable para una
herramienta local de un solo usuario; si hiciera falta concurrencia, `runs` ya es
un Map y soporta varios.

## D10 — La UI usa el vocabulario de Claude Code, no uno propio

**Contexto.** El panel mostraba `@seguridad`, `guard-git.sh` y `/us` como chips
indistintos. Para quien ya conocía el plugin alcanzaba; para cualquier otro no
había forma de saber que uno es un subagente, otro un script y otro un skill —ni
qué significa cada una de esas cosas.

**Decisión.** Cada componente lleva su tipo visible —Skill, Subagente, Hook,
Script, MCP server, Referencia, Manifiesto— con los nombres exactos de Claude
Code, más una explicación en lenguaje llano al abrirlo y un glosario completo en
la barra superior.

**Por qué los nombres oficiales.** Era tentador traducirlos a algo más amable
("revisores", "reglas automáticas"). Se descartó: el objetivo no es que el panel
se entienda solo, es que quien lo use termine entendiendo Claude Code. Un
vocabulario propio se entiende más rápido y no sirve en ningún otro lado —ni en
la documentación, ni en la terminal, ni hablando con otro equipo. La
simplificación va en la explicación, nunca en el término.

**Dónde vive.** `KINDS` en `public/index.html`. Un tipo de componente que no se
agregue ahí aparece sin etiqueta.

## D11 — La implementación también es un subagente

**Contexto.** Hasta acá los cinco agentes auditaban y la sesión principal
escribía el código. Funcionaba, pero dejaba el rol más pesado del ciclo sin
instructivo propio: la calidad de la implementación dependía del prompt del
skill orquestador, mezclado con la lógica de encadenar fases.

**Decisión.** Un sexto agente, `desarrollador`, con perfil de developer senior
fullstack. Es el único agente que corrige código: implementa la fase 4 y recibe las
correcciones de `qa`, `seguridad` y `reviewer`. La sesión principal pasa a
orquestar y nada más.

**Por qué.** Tres cosas que antes no se podían hacer:

1. **Calibrarlo.** Modelo, esfuerzo y turnos de la implementación ahora se
   ajustan solos, sin tocar el skill. Es lo mismo que ya valía para los otros
   demás auditores.
2. **Auditarlo.** Su salida es JSON con `verdict`, así que un run bloqueado en
   implementación se ve igual que uno bloqueado en refinamiento, con sus
   `blocking_questions`.
3. **Frenar donde corresponde.** Antes, si el plan no alcanzaba, la sesión
   principal improvisaba —tenía todo el contexto y ninguna instrucción de
   parar—. El agente tiene criterio explícito de cuándo devolver BLOCKED.

**Lo que no cambia.** D3 sigue en pie: quien audita no corrige su propio
hallazgo. La sesión principal sólo persiste artefactos del run y el desarrollador
es el único agente que modifica código de producto.

**Costo.** El contexto ya no es gratis. La sesión principal tenía el plan y el
código que acababa de escribir; el subagente arranca limpio en cada ciclo de
corrección y hay que volver a pasarle `plan.md` y los hallazgos. Por eso los
hallazgos de `qa` y `seguridad` se le mandan **juntos**: invocarlo dos veces
seguidas le hace releer el mismo código para nada.

Si en el piloto los ciclos de corrección resultan caros, la salida no es volver
atrás sino que el agente reciba el diff en vez del repo entero.

## D12 — Cualquier agente se puede apagar, y apagarlo es un hook

**Contexto.** El ciclo asumía que todos sus agentes corren siempre. La primera
vez que eso no alcanzó fue con diseño: un agente de UX es indispensable en un
repo de frontend e inútil en uno de backend, donde produce hallazgos genéricos
que nadie puede accionar. Y esos hallazgos son peores que no tener el agente,
porque entrenan al equipo a ignorar la salida del ciclo.

El caso se generaliza: un equipo sin design system, uno que ya corre su propio
security scanner en CI, uno que hace code review humano y no quiere el reviewer
adversarial. Todos necesitan lo mismo.

**Decisión.** Cualquier agente se habilita o deshabilita por proyecto, en
`<repo>/.claude/globant-sdlc.json`. `@ux` y las dos integraciones de diseño
—Figma y Storybook— vienen apagadas; el resto, encendido.

La config vive en el repo objetivo y no en el `userConfig` del plugin porque es
una propiedad del proyecto, no de la persona: que un repo tenga interfaz que
revisar no cambia según quién corra el ciclo. Además se versiona, así que el que
clona hereda la misma configuración sin enterarse por Slack.

**El gate es un hook, no una instrucción del skill.** `guard-agents.sh` corre en
`PreToolUse` sobre `Task` y deniega la invocación de un agente apagado. Un prompt
que dice "no lo invoques" es una sugerencia fuerte; deshabilitar tiene que
significar que no corre. Es la misma regla de D5.

**Costo y modos de falla.** El parser de la config es `sed` y `grep` —cero
dependencias, igual que el resto— así que soporta un solo nivel de anidamiento y
booleanos en su propia línea. Un archivo con otro formato no rompe: cae a los
defaults. Los defaults están elegidos para que ese camino sea el seguro —los
agentes que auditan quedan encendidos, y los que dependen de una integración
externa, apagados—, así que una config ilegible nunca resulta en menos control.

Deshabilitar `desarrollador` deja el ciclo sin nadie que escriba: el skill lo
detecta y termina en vez de implementar la historia por su cuenta. Deshabilitar
`refinamiento` apaga el circuit breaker de D2; se permite, pero el PR lo dice.

## D13 — El diseño entra antes de implementar, no después

**Contexto.** Un agente de UX y Visual Design puede correr en dos lugares: antes
de implementar, produciendo el contrato de UI, o después, auditando la pantalla
construida.

**Decisión.** Antes, como fase 3, entre arquitectura e implementación.

El costo caro de no tener diseño en el ciclo no es una pantalla fea: es un
componente nuevo escrito desde cero cuando ya existía uno equivalente en el
design system. Eso se evita antes de escribir el código; después ya es un
refactor que compite con el resto del backlog.

**Cómo se audita entonces el resultado.** El agente emite `visual_acceptance`,
criterios verificables que van a `design.md`, y `qa` los traza igual que a los
de la historia. No hizo falta un segundo agente: alcanzó con que el contrato sea
verificable.

**Costo.** Con diseño habilitado el ciclo tiene una invocación más antes de
implementar. En una historia sin interfaz el agente devuelve `N_A` y no cuesta
más que ese turno, que es el caso esperado en un repo mixto.
