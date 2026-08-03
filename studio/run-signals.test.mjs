import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_CORRECTION_ROUNDS,
  RECOVERY_PROMPT,
  correctionRoundForTransition,
  finalCycleCompletion,
  prCommand,
  prTool,
  technicalToolInterruption,
} from './run-signals.mjs';

test('cuenta sólo regresos reales a implementación', () => {
  assert.equal(MAX_CORRECTION_ROUNDS, 3);
  assert.equal(correctionRoundForTransition(3, 0, 'desarrollador'), 0);
  assert.equal(correctionRoundForTransition(5, 0, 'desarrollador'), 1);
  assert.equal(correctionRoundForTransition(6, 1, 'desarrollador'), 2);
  assert.equal(correctionRoundForTransition(5, 2, 'qa'), 2);
});

test('reconoce solo el marcador técnico de interrupción', () => {
  assert.equal(technicalToolInterruption('[Request interrupted by user for tool use]'), true);
  assert.equal(technicalToolInterruption('Request interrupted by user'), true);
  assert.equal(technicalToolInterruption('El usuario pidió detener el ciclo'), false);
});

test('la recuperación exige reconciliar efectos antes de repetir', () => {
  assert.match(RECOVERY_PROMPT, /Antes de repetir nada, reconciliá/);
  assert.match(RECOVERY_PROMPT, /no la repitas/);
  assert.match(RECOVERY_PROMPT, /Reintentá.+únicamente si confirmás que no se completó/);
});

test('clasifica creación y actualización de PR', () => {
  assert.deepEqual(prCommand('gh pr create --draft'), { creates: true, touches: true });
  assert.deepEqual(prCommand('gh pr edit 12 --title nuevo'), { creates: false, touches: true });
  assert.deepEqual(prCommand('az repos pr show --id 12'), { creates: false, touches: true });
  assert.deepEqual(prCommand('git push origin feature/x'), { creates: false, touches: false });
});

test('clasifica herramientas MCP de PR sin depender de Bash', () => {
  assert.deepEqual(prTool('mcp__github__create_pull_request'), { creates: true, touches: true });
  assert.deepEqual(prTool('mcp__ado__repo_update_pull_request'), { creates: false, touches: true });
  assert.deepEqual(prTool('mcp__github__get_issue'), { creates: false, touches: false });
});

test('no completa por prosa sin evidencia de una herramienta de PR', () => {
  const result = 'Ciclo completo. PR: https://github.com/acme/repo/pull/12';
  assert.equal(finalCycleCompletion(result, false), false);
  assert.equal(finalCycleCompletion(result, true), true);
});

test('no completa una frase negativa aunque tenga URL y evidencia', () => {
  const result = 'Todavía no está listo para revisión humana. PR: https://github.com/acme/repo/pull/12';
  assert.equal(finalCycleCompletion(result, true), false);
});

test('completa la ruta de PR existente confirmada', () => {
  const result = 'PR: https://gitlab.com/acme/repo/merge_requests/7 — listo para revisión humana.';
  assert.equal(finalCycleCompletion(result, true), true);
});
