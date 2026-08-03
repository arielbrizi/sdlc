import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { discoverProjectProfile, isolatedWorktreePath, normalizeRepoName, repoHintVerdict, repoNames, safeScope } from './repository.mjs';

test('normaliza nombres de repositorios sin puntuación ni .git', () => {
  assert.equal(normalizeRepoName('Consumo-API.git'), 'consumoapi');
});

test('repo_hint acepta el nombre remoto o el subproyecto', () => {
  const names = repoNames('/tmp/plataforma', 'git@github.com:org/consumo-api.git', 'apps/web');
  assert.equal(repoHintVerdict('consumo-api', names).status, 'match');
  assert.equal(repoHintVerdict('web', names).status, 'match');
  assert.equal(repoHintVerdict('otro-repo', names).status, 'mismatch');
});

test('varios hints se reconocen como historia multirepo', () => {
  assert.equal(repoHintVerdict('frontend, backend', ['frontend']).status, 'multi-repo');
});

test('el worktree es estable por repo e historia', () => {
  const a = isolatedWorktreePath('/tmp/ws', '/tmp/repo', 'ABC-1');
  const b = isolatedWorktreePath('/tmp/ws', '/tmp/repo', 'ABC-1');
  assert.equal(a, b);
  assert.match(a, /ABC-1$/);
  assert.notEqual(a, isolatedWorktreePath('/tmp/ws', '/tmp/repo', 'ABC-1', 'apps/web'));
});

test('safeScope no permite salir del repositorio', () => {
  assert.equal(safeScope('/tmp', '.'), path.resolve('/tmp'));
  assert.throws(() => safeScope('/tmp', '../etc'), /sale del repositorio/);
});

test('descubre stack y comandos sin ejecutar el proyecto', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow360-profile-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'vite build' } }));
    const profile = await discoverProjectProfile(dir);
    assert.deepEqual(profile.technologies, ['Node.js']);
    assert.equal(profile.commands.test, 'npm run test');
    assert.equal(profile.ready, true);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
