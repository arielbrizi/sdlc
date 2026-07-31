# globant-ai-sdlc

Marketplace interno de Globant para plugins de Claude Code.

| Plugin | Qué hace |
|---|---|
| [`globant-sdlc`](./plugins/globant-sdlc) | Ciclo de una historia de usuario de punta a punta, desde el ID del ticket hasta un PR en draft |

## Para el developer

```bash
# Una sola vez
claude plugin marketplace add globant/globant-ai-sdlc
claude plugin install globant-sdlc@globant --scope project

# En el día a día
/us GLOB-1234      # Jira
/us 8891           # Azure DevOps
/us #245           # GitHub Issues
```

## Studio

Panel local para ver el plugin como sistema, editar cualquier componente y
seguir un run fase por fase.

```bash
./scripts/studio.sh --repo ~/repos/mi-proyecto
# http://127.0.0.1:4477
```

Sin dependencias npm. Detalle en [`studio/README.md`](./studio/README.md).

## Para quien mantiene el framework

```bash
git clone git@github.com:globant/globant-ai-sdlc.git
cd globant-ai-sdlc
chmod +x plugins/*/scripts/*.sh scripts/*.sh
./scripts/validate.sh
```

Iterar cargando el plugin sin instalarlo, contra un repo sandbox:

```bash
cd ~/repos/sandbox
claude --plugin-dir ~/repos/globant-ai-sdlc/plugins/globant-sdlc
```

`CLAUDE.md` tiene las reglas de trabajo sobre este repo y las lee Claude Code
automáticamente. `docs/decisiones.md` explica por qué el framework es como es.

## Versionado

Durante el desarrollo, `plugin.json` **no** lleva campo `version`: Claude Code
usa el SHA del commit y el equipo recibe cada cambio mergeado. Cuando el plugin
se estabilice, agregar `version` y bumpearlo en cada release — a partir de ahí,
sin bump no hay actualización aunque pushees.

## CI

`.github/workflows/validate.yml` corre `claude plugin validate --strict` sobre el
marketplace y cada plugin, más los checks de sintaxis y permisos. Un manifest
inválido rompe el plugin para todo el equipo, así que el check es bloqueante.

## Contribuir

1. Branch desde `main`
2. `./scripts/validate.sh` en verde
3. Probar end-to-end contra un ticket real en un repo sandbox
4. PR con qué cambió y qué probaste

Si agregás un agente, actualizá también el flujo en el `SKILL.md` que lo invoca
y registrá la decisión en `docs/decisiones.md`.
