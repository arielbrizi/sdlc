import test from 'node:test';
import assert from 'node:assert/strict';
import { toolActivity } from './tool-activity.mjs';

test('explica ToolSearch para Git sin exponer la consulta técnica', () => {
  const activity = toolActivity('ToolSearch', { query: '+bash shell command git' });
  assert.equal(activity.summary,
    'Buscando una herramienta para ejecutar comandos del repositorio y trabajar con Git');
  assert.match(activity.success, /recibió una respuesta/);
  assert.doesNotMatch(activity.summary, /\+bash/);
});

test('explica búsquedas y archivos con contexto breve', () => {
  assert.equal(toolActivity('Grep', { pattern: 'FLOW360' }).summary,
    'Buscando “FLOW360” en el proyecto');
  assert.equal(toolActivity('Read', { file_path: '/repo/studio/server.mjs' }).progress,
    'Leyendo studio/server.mjs');
});
