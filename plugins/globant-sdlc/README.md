# globant-sdlc

Plugin de Claude Code que corre el ciclo de una historia de usuario de punta a
punta, desde el ID del ticket hasta un Pull Request en draft.

```bash
/us GLOB-1234      # Jira
/us 8891           # Azure DevOps
/us #245           # GitHub Issues
```

¿Sin tracker? La historia se escribe a mano en el studio y el ciclo es el mismo
(ver [Historias sin tracker](#historias-sin-tracker)).

## Qué hace

```
/us <ID>
  │
  ├─ 0  resolve-story.sh   detecta tracker, normaliza la historia
  ├─ 1  @refinamiento      ⛔ CIRCUIT BREAKER: aborta si la US es ambigua
  ├─ 2  @arquitectura      plan.md  (⛔ aborta si blast_radius: high)
  ├─ 3  @desarrollador     branch + código + tests (el único que escribe)
  ├─ 4  @qa ‖ @seguridad   auditan en paralelo; corrigen volviendo a la 3
  ├─ 5  @reviewer          revisión adversarial del diff
  └─ 6  PR en draft + comentario en el ticket
```

## Instalación

```bash
# 1. Publicar en el marketplace interno y instalar a nivel proyecto
claude plugin install globant-sdlc@globant --scope project

# 2. Verificar
claude plugin details globant-sdlc
```

`--scope project` lo escribe en `.claude/settings.json` del repo: queda
versionado y todo el que clona lo tiene.

Para desarrollo local del propio plugin:

```bash
claude --plugin-dir ./globant-sdlc
```

**Los scripts necesitan permiso de ejecución** después de clonar:

```bash
chmod +x scripts/*.sh
```

### Variables de entorno

| Variable | Para qué |
|---|---|
| `JIRA_MCP_TOKEN` | Auth del MCP de Jira |
| `ADO_ORG` | Organización de Azure DevOps |
| `GITHUB_TOKEN` | Auth del MCP de GitHub |
| `GLOBANT_PROTECTED_BRANCHES` | Regex de branches protegidas (default: `main\|master\|develop\|release/.*`) |

## Historias sin tracker

Integrar con Jira o ADO no es requisito para usar el plugin. Con
`--tracker manual` la historia se escribe a mano:

```bash
./scripts/studio.sh --repo ~/repos/mi-proyecto
# Fuente: escrita acá → pestaña Historia → Ejecutar
```

El studio la guarda en `.claude/run/<ID>/story.json` con el esquema canónico
antes de arrancar el run, y el resolver la encuentra ahí sin consultar ningún
MCP. También podés escribir ese archivo a mano y correr
`/us <ID> --tracker manual` directo desde la terminal.

De la fase 1 en adelante nada distingue una historia escrita a mano de una que
vino de un tracker — incluido `@refinamiento`, que la bloquea igual si los
criterios de aceptación faltan o no son verificables. Lo que cambia es que no hay
a dónde escribir de vuelta: las preguntas bloqueantes quedan en
`.claude/run/<ID>/blocked.md` y el PR es el único registro de la historia.

## Las tres decisiones de diseño que importan

**1. El PR es el gate, no el flujo.** El ciclo corre sin interrupciones porque
el merge sigue siendo humano. Por eso el PR se abre en *draft*, con la
autoevaluación de cada agente y una sección explícita de "qué revisar con
atención". Un PR que se presenta como terminado invita al rubber-stamp; uno que
declara dónde tiene menos confianza, no.

**2. El circuit breaker está al principio, no al final.** El paso 0 es
refinamiento y puede abortar todo el run. En un flujo automático el costo no es
el error detectado tarde: es haber gastado 40 minutos y contexto sobre una
historia que nadie podía implementar. Además convierte la calidad del backlog
en una señal medible.

**3. Quien audita no escribe.** `qa`, `seguridad`, `arquitectura`,
`refinamiento` y `reviewer` tienen `disallowedTools: Write, Edit`. El único que
escribe es `desarrollador`. Un agente que puede corregir lo que audita termina
aprobándose solo, así que la separación es estructural —a nivel de herramientas
disponibles— y no una instrucción en el prompt.

## Qué es hook y qué es prompt

Los hooks son código: no dependen de que el modelo se acuerde de la regla.

| Regla | Implementación |
|---|---|
| No leer `.env`, `.pem`, `credentials`, `tfstate` | `guard-secrets.sh` (PreToolUse) |
| No force push, no reset --hard, no commit en branch protegida | `guard-git.sh` (PreToolUse) |
| Formatear y lintar todo lo que se toca | `format-and-lint.sh` (PostToolUse) |
| Registrar el veredicto de cada agente | `log-run.sh` (SubagentStop) |

Todo lo que sea política de compañía va acá. Lo que requiera criterio, al agente.

## Auditoría

Cada run deja rastro en `.claude/run/<ID>/`:

```
.claude/run/GLOB-1234/
├── run.json        quién, cuándo, sobre qué branch
├── story.json      la historia normalizada
├── plan.md         el plan de arquitectura
├── qa.json         veredicto de QA
├── security.json   veredicto de seguridad
├── review.json     revisión adversarial
└── timeline.log    cierre de cada agente
```

Agregá `.claude/run/` al `.gitignore` del repo, salvo que quieras la evidencia
versionada — que para auditorías de compliance puede ser deseable.

## Adaptar a un repo

El plugin trae el proceso; el repo aporta el contexto. Cada repo necesita:

```
.claude/
├── rules/
│   ├── stack.md         lenguaje, framework, versiones, libs permitidas
│   ├── arquitectura.md  capas, dónde va cada cosa, qué no se cruza
│   ├── testing.md       framework, cobertura mínima, qué se mockea
│   └── convenciones.md  naming, estructura de carpetas, commits
└── settings.json
```

Sin esto, los agentes trabajan por defaults genéricos y el resultado es
inconsistente entre repos. Es el trabajo menos glamoroso del rollout y el que
más mueve la aguja.

## Métricas del piloto

Medir desde el día uno, antes de escalar:

| Métrica | Por qué |
|---|---|
| % de runs abortados en refinamiento | Calidad real del backlog |
| Lead time de la historia | El caso de negocio |
| % de PRs que mergean sin rework | Calidad del output |
| Hallazgos de seguridad pre-merge | El valor menos visible y más caro de omitir |
| Tokens por historia | Sostenibilidad económica |

Si el primer número es alto, el problema no es el framework: es el refinement.
Vale la pena saberlo igual.

## Roadmap

- [ ] Piloto en un repo con un squad
- [ ] `.claude/rules/` por stack (Java/Spring, Node, .NET, Python)
- [ ] Marketplace interno de Globant
- [ ] `/auditoria-seguridad` y `/migrar` como workflows dinámicos
- [ ] Managed settings a nivel organización para las políticas no negociables
