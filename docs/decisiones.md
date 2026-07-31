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

## D2 — Dos abortos automáticos

**Contexto.** Sin gates intermedios, el flujo necesita poder frenarse solo.

**Decisión.** Dos condiciones abortan el run:
1. `refinamiento` devuelve `BLOCKED` — la historia no es implementable
2. `arquitectura` declara `blast_radius: high` — auth, pagos, PII, migración
   destructiva o contrato público

**Por qué.** El costo del modo automático no es el bug detectado tarde: es gastar
el ciclo completo sobre supuestos equivocados, o aplicar autonomía donde
equivocarse es caro. Full auto para el 80% de las historias; el 20% restante
pide humano por diseño.

## D3 — Quien audita no escribe

**Decisión.** `refinamiento`, `arquitectura`, `qa`, `seguridad` y `reviewer`
tienen `disallowedTools: Write, Edit`.

**Por qué.** Un agente que puede corregir lo que audita se aprueba solo. La
separación tiene que ser estructural — a nivel de herramientas disponibles — y no
una instrucción en el prompt, que el modelo puede racionalizar.

## D4 — Adaptación de trackers en el borde

**Contexto.** Hay que soportar Jira, Azure DevOps y GitHub Issues.

**Decisión.** `resolve-story.sh` detecta el tracker y normaliza a un `story.json`
canónico. Los agentes solo conocen ese esquema.

**Por qué.** Si los agentes conocieran a Jira, sumar un tracker obligaría a tocar
los cinco. Con la adaptación en el borde, sumar uno es agregar un mapeo.

## D5 — Política en hooks, criterio en agentes

**Decisión.** Secretos, git destructivo, formateo y auditoría son hooks. Todo lo
que requiera juicio es agente.

**Por qué.** Un hook ejecuta código: no puede alucinar ni ser persuadido. Un
prompt es una sugerencia fuerte. Las reglas que nunca deberían poder saltearse
no pueden depender de que el modelo las recuerde en el turno 40.

## D6 — Marketplace propio, no `.claude/` suelto

**Decisión.** Distribuir como plugin desde un marketplace interno, en vez de
copiar un `.claude/` en cada repo.

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
