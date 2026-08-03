import test from 'node:test';
import assert from 'node:assert/strict';
import { hookEventsSince } from './hook-events.mjs';

test('lee activaciones nuevas y descarta runs anteriores o líneas inválidas', () => {
  const startedAt = Date.parse('2026-08-03T12:00:00Z');
  const content = [
    '{"event":"PreToolUse","script":"guard-git.sh","run":"run-1","at":"2026-08-03T11:59:00Z"}',
    'no es json',
    '{"event":"PreToolUse","script":"guard-git.sh","run":"run-1","at":"2026-08-03T12:00:01Z"}',
    '{"event":"PostToolUse","script":"format-and-lint.sh","run":"otro-run","at":"2026-08-03T12:00:02Z"}',
    '{"event":"PostToolUse","script":"format-and-lint.sh","run":"run-1","at":"2026-08-03T12:00:02Z"}',
    '',
  ].join('\n');

  const first = hookEventsSince(content, 0, startedAt, 'run-1');
  assert.equal(first.cursor, 5);
  assert.deepEqual(first.events.map(e => [e.event, e.script]), [
    ['PreToolUse', 'guard-git.sh'],
    ['PostToolUse', 'format-and-lint.sh'],
  ]);

  const appended = content +
    '{"event":"SubagentStop","script":"log-run.sh","run":"run-1","at":"2026-08-03T12:00:03Z"}\n';
  const second = hookEventsSince(appended, first.cursor, startedAt, 'run-1');
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].script, 'log-run.sh');
});

test('espera una línea incompleta y se recupera si el archivo se trunca', () => {
  const partial = '{"event":"PreToolUse","script":"guard-agents.sh","run":"run-1"';
  assert.deepEqual(hookEventsSince(partial, 0, 0), { cursor: 0, events: [] });

  const complete = partial + ',"at":"2026-08-03T12:00:00Z"}\n';
  assert.equal(hookEventsSince(complete, 5, 0).events.length, 1);
});
