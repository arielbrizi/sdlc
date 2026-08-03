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
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
printf '%s\n' '{"tool_input":{"command":"git status"}}' \\
  | CLAUDE_PROJECT_DIR="$PWD" CLAUDE_PLUGIN_ROOT="$FLOW360_TEST_PLUGIN_ROOT" \\
    "$FLOW360_TEST_PLUGIN_ROOT/scripts/guard-git.sh"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-test"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"ToolSearch","input":{"query":"+bash shell command git"}}]}}'
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":[]}]}}'
printf '%s\n' '{"type":"result","is_error":false,"result":"Turno terminado","num_turns":1,"total_cost_usd":0}'
`, { mode: 0o755 });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'branch', '-M', 'main');

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const server = spawn(process.execPath, [
    path.join(ROOT, 'studio/server.mjs'), '--repo', repo, '--workspace', workspace, '--port', String(port),
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FLOW360_TEST_PLUGIN_ROOT: path.join(ROOT, 'plugins/globant-sdlc'),
    },
    stdio: 'ignore',
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(`${baseUrl}/api/plugin`);
    const plugin = await fetch(`${baseUrl}/api/plugin`).then(r => r.json());
    assert.equal(plugin.targetRepo, path.resolve(repo));
    assert.equal(plugin.targetRepoExplicit, true);
    const prepare = await fetch(`${baseUrl}/api/repo/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: path.join(repo, 'apps/web') }),
    }).then(r => r.json());
    assert.equal(prepare.dir, fs.realpathSync(repo));
    assert.ok(prepare.workspaces.includes('apps/web'));

    const missingScope = await fetch(`${baseUrl}/api/repo/preflight`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoDir: repo, baseBranch: 'main', storyId: 'LOCAL-1' }),
    });
    assert.equal(missingScope.status, 400);
    assert.match(await missingScope.text(), /elegí el alcance/);

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

    for (let i = 0; i < 40; i += 1) {
      const info = await fetch(`${baseUrl}/api/run/${run.runId}`).then(r => r.json());
      if (!info.vivo) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const stream = await fetch(`${baseUrl}/api/run/${run.runId}/stream`).then(r => r.text());
    assert.match(stream, /"t":"hook"/);
    assert.match(stream, /"script":"guard-git\.sh"/);
    assert.match(stream, /"t":"init","sessionId":"session-test"/);
    assert.match(stream, /"progress":"Buscando una herramienta para ejecutar comandos del repositorio y trabajar con Git"/);
    assert.match(stream, /"success":"Búsqueda completada; Claude Code recibió una respuesta y puede continuar"/);
    assert.match(stream, /"isError":false/);
  } finally {
    const closed = new Promise(resolve => server.once('close', resolve));
    server.kill('SIGTERM');
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
