import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildReportModel, writePdf } from '../plugins/sdlc/scripts/generate-run-report.mjs';

function json(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

test('genera un PDF con decisiones de los siete agentes sin invocar un modelo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-report-'));
  json(dir, 'story.json', {
    id: 'PROJ-42', title: 'Catálogo de materiales', tracker: 'jira',
    acceptance_criteria: ['Permite buscar materiales'],
  });
  json(dir, 'git.json', { branch: 'feature/PROJ-42', base_ref: 'main' });
  json(dir, 'refinement.json', {
    verdict: 'READY', assumptions_safe_to_make: ['La búsqueda es textual'],
    acceptance_criteria_normalized: ['Dado un catálogo, encuentra coincidencias'],
    estimated_blast_radius: 'medium', blocking_questions: [],
  });
  json(dir, 'architecture.json', {
    verdict: 'PROCEED', blast_radius: 'medium', decision_summary: {
      guidelines: ['Separar dominio de infraestructura'],
      technologies: [{ name: 'PostgreSQL', decision: 'usar', reason: 'búsqueda indexada' }],
      patterns: [{ name: 'Repository', application: 'persistencia de materiales' }],
      constraints: ['No agregar servicios externos'],
    },
  });
  json(dir, 'design.json', {
    verdict: 'DESIGNED', decision_summary: {
      reuse: ['SearchInput existente'], new_components: [], tokens: ['spacing-3'],
      interactions: ['Debounce de 300 ms'], accessibility: ['Label visible'],
    }, sources: { storybook: 'inspeccionado' },
  });
  json(dir, 'implementation.json', {
    verdict: 'DONE', files_changed: [{ path: 'src/catalog.js', action: 'modified' }],
    tests: { run: 'npm test' }, acceptance_criteria: [{ criterion: 'AC1', covered_by: 'catalog.test.js' }],
  });
  json(dir, 'qa.json', { verdict: 'PASS', findings: [], acceptance_coverage: ['AC1'], test_run: 'npm test' });
  json(dir, 'security.json', { verdict: 'PASS', findings: [], dependencies_added: [] });
  json(dir, 'review.json', { verdict: 'APPROVE', blocking: [], non_blocking: [], review_focus_for_human: ['Índice de búsqueda'] });
  fs.writeFileSync(path.join(dir, 'timeline.log'), [
    '2026-08-04T10:00:00Z agent=sdlc:arquitectura verdict=READY finished',
    '2026-08-04T10:01:00Z agent=sdlc:arquitectura verdict=READY finished',
  ].join('\n'));

  const model = buildReportModel(dir, { prUrl: 'https://example.test/pull/42' });
  assert.equal(model.agents.length, 7);
  assert.equal(model.agents.every(agent => agent.available), true);
  assert.match(model.agents.find(agent => agent.name === 'arquitectura').decisions.join('\n'), /PostgreSQL/);
  assert.match(model.agents.find(agent => agent.name === 'arquitectura').decisions.join('\n'), /Repository/);
  assert.match(model.agents.find(agent => agent.name === 'arquitectura').retrospective.join('\n'), /2 ejecuciones/);

  const output = path.join(dir, 'report.pdf');
  const result = writePdf(model, output);
  const bytes = fs.readFileSync(output);
  assert.ok(result.pages >= 2);
  assert.equal(bytes.subarray(0, 8).toString('latin1'), '%PDF-1.4');
  assert.match(bytes.toString('latin1'), /Reporte final del ciclo SDLC/);
  assert.ok(bytes.length > 10_000);
});

test('marca como retroalimentación los agentes que no dejaron artefacto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-report-partial-'));
  json(dir, 'story.json', { id: 'LOCAL-1', title: 'Run parcial' });
  const model = buildReportModel(dir);
  const qa = model.agents.find(agent => agent.name === 'qa');
  assert.equal(qa.verdict, 'NO_EJECUTADO');
  assert.match(qa.retrospective[0], /No hay artefacto/);
});
