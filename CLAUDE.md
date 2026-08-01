# globant-ai-sdlc

Marketplace interno de Globant. Contiene `globant-sdlc`, el plugin que corre el
ciclo de una historia de usuario de punta a punta hasta el PR.

Este repo se desarrolla con Claude Code. Lo que sigue es contexto vinculante
para trabajar sobre él.

## Estructura

```
.claude-plugin/marketplace.json   catálogo — registra cada plugin
plugins/<nombre>/                 un plugin por directorio
  .claude-plugin/plugin.json      manifest
  skills/<skill>/SKILL.md         entrypoints que corre el dev
  agents/*.md                     subagentes especializados
  hooks/hooks.json                política determinística
  scripts/*.sh                    scripts de hooks y utilidades
studio/                           panel local: inspección, edición y runs
scripts/validate.sh               validación local (mismo check que CI)
docs/                             decisiones de diseño
```

## Reglas del repo

**Todo cambio pasa por `./scripts/validate.sh` antes de commitear.** Es lo mismo
que corre CI. Un manifest inválido rompe el plugin para todo el equipo.

**Los scripts van con bit de ejecución.** `git update-index --chmod=+x` si se
perdió. El validador lo chequea porque es el error más frecuente y el más
silencioso: el hook simplemente no dispara.

**Bumpear `version` en `plugin.json` en todo cambio que el equipo deba recibir.**
El campo es obligatorio: `claude plugin validate --strict` falla sin él. Y una
vez presente manda ese número, no el SHA del commit — sin bump, quien ya tiene el
plugin instalado no ve el cambio aunque esté mergeado en `main`. Va en `0.x`
mientras el plugin no se estabilice.

**Todo path relativo arranca con `./`** y no sale del root del plugin. Los
plugins se copian a un cache al instalarse: un `../shared/` funciona en local
y falla instalado.

**En scripts y hooks, usar `${CLAUDE_PLUGIN_ROOT}`,** nunca paths absolutos ni
relativos al cwd.

## Convenciones de los agentes

Cada agente en `agents/` sigue el mismo contrato:

- `disallowedTools: Write, Edit` para todo agente que **audita**. La separación
  entre quien escribe y quien evalúa es estructural, no opcional.
- Salida en JSON con un campo `verdict`. El skill orquestador ramifica sobre él.
- Un criterio explícito de cuándo bloquear, con ejemplos de qué **no** bloquear.
  Sin eso los agentes derivan a ser permisivos o a generar ruido.
- Prosa directa, en español, sin relleno motivacional.

Al agregar un agente nuevo, replicá ese contrato y registralo en el flujo del
SKILL.md correspondiente. Un agente que nadie invoca solo consume contexto.

## Qué va en hook y qué va en agente

| Va a hook | Va a agente |
|---|---|
| Regla determinística y no negociable | Requiere criterio o contexto |
| Puede evaluarse con un exit code | La respuesta correcta depende del caso |
| Política de compañía | Calidad técnica |

Ante la duda: si la regla no debería poder saltearse nunca, es hook. Un prompt
es una sugerencia fuerte; un hook es una barrera.

## El studio

`studio/` es un servidor Node sin dependencias que sirve un panel local. Si
agregás una fase al skill `us` o un agente nuevo, hay dos lugares que actualizar
o el panel queda desincronizado del plugin real:

- `PHASES` y `AGENT_PHASE` en `studio/server.mjs` — el modelo de fases y qué
  agente corresponde a cuál
- `PHASE_PARTS` y `PHASE_HELP` en `studio/public/index.html` — qué componentes
  cuelgan de cada fase en el diagrama, y la línea que explica qué pasa ahí

Si agregás un **tipo** de componente nuevo (no un componente, un tipo), va
también en `KINDS` de `studio/public/index.html`: es lo que le pone la etiqueta
—Skill, Subagente, Hook— y alimenta el glosario. Usá el nombre que le da Claude
Code, no uno inventado: el studio enseña el vocabulario real. Lo que se escribe
en criollo es la explicación, nunca el término.

Es duplicación deliberada: el studio conoce el ciclo del skill `us`, que es
específico, mientras que el escaneo del plugin es genérico. Si algún día hay más
de un skill orquestador, ese mapeo se mueve al SKILL.md y el studio lo lee.

## Probar cambios

```bash
# Cargar el plugin sin instalarlo, contra un repo de prueba
cd ~/repos/sandbox
claude --plugin-dir ~/repos/globant-ai-sdlc/plugins/globant-sdlc

# Ver qué componentes aporta y cuánto contexto cuesta
claude plugin details globant-sdlc

# Diagnóstico de carga
claude --debug
```

Los cambios en un `SKILL.md` toman efecto en la sesión activa. Los cambios en
`hooks/`, `agents/`, `.mcp.json` y `plugin.json` **no**: requieren
`/reload-plugins` o reiniciar.

## Antes de dar por terminado un cambio

1. `./scripts/validate.sh` pasa
2. Bumpeaste `version` si el equipo tiene que recibir el cambio
3. Probaste el flujo end-to-end contra un ticket real en un repo sandbox
4. Si tocaste un agente, verificaste que su salida JSON sigue parseando en el skill
5. Si tocaste un hook, lo probaste en los dos sentidos: que bloquee lo que debe
   y que **no** bloquee lo que no debe

El punto 5 es el que más se saltea. Un hook con falsos positivos hace que el
equipo lo desactive, y ahí perdiste la política entera.
