import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

const git = (cwd, ...args) => {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
};

async function waitFor(url) {
  for (let i = 0; i < 40; i += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Studio no inició a tiempo');
}

test('prepara monorepo, confirma contexto y ejecuta en worktree aislado', { timeout: 20_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flow360-server-'));
  const repo = path.join(tmp, 'repo');
  const workspace = path.join(tmp, 'workspace');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(path.join(repo, 'apps/web'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(repo, 'apps/web/package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'branch', '-M', 'main');

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const server = spawn(process.execPath, [
    path.join(ROOT, 'studio/server.mjs'), '--repo', repo, '--workspace', workspace, '--port', String(port),
  ], { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(`${baseUrl}/api/plugin`);
    const prepare = await fetch(`${baseUrl}/api/repo/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: path.join(repo, 'apps/web') }),
    }).then(r => r.json());
    assert.equal(prepare.dir, fs.realpathSync(repo));
    assert.ok(prepare.workspaces.includes('apps/web'));

    const preflight = await fetch(`${baseUrl}/api/repo/preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoDir: repo, baseBranch: 'main', scope: 'apps/web', storyId: 'LOCAL-1', repoHint: 'web' }),
    }).then(r => r.json());
    assert.equal(preflight.hint.status, 'match');
    assert.deepEqual(preflight.profile.technologies, ['Node.js']);

    const response = await fetch(`${baseUrl}/api/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'manual', repoDir: repo, baseBranch: 'main', scope: 'apps/web', isolate: true,
        story: { id: 'LOCAL-1', title: 'Cambio web', repoHint: 'web', acceptanceCriteria: 'Funciona' },
      }),
    });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const run = JSON.parse(raw);
    assert.equal(run.isolated, true);
    assert.notEqual(run.cwd, path.join(repo, 'apps/web'));
    assert.ok(fs.existsSync(path.join(run.cwd, '.claude/run/LOCAL-1/repo-context.json')));
    assert.ok(fs.existsSync(path.join(run.cwd, '.claude/run/LOCAL-1/story.json')));
  } finally {
    const closed = new Promise(resolve => server.once('close', resolve));
    server.kill('SIGTERM');
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
