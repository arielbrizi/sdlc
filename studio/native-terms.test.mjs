import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

test('el Studio usa conceptos nativos de Claude Code', () => {
  for (const label of ['Skill', 'Subagent', 'Hook', 'MCP server', 'Supporting file',
    'Plugin manifest', 'Tool', 'Plugin']) {
    assert.match(html, new RegExp(`label: '${label}'`));
  }
  assert.doesNotMatch(html, /label: '(Subagente|Referencia|Manifiesto|Herramienta)'/);
});

test('el detalle de Hook enseña su estructura nativa', () => {
  assert.match(html, />Hook event</);
  assert.match(html, />Matcher group</);
  assert.match(html, />Hook handler · command</);
  assert.match(html, /no cuántas tool calls bloqueó/);
});
