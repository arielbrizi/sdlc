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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-server-'));
  const repo = path.join(tmp, 'repo');
  const workspace = path.join(tmp, 'workspace');
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(path.join(repo, 'apps/web'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(repo, 'apps/web/package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
case "$*" in
  *"auth status --json"*)
    printf '%s\n' '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'
    exit 0
    ;;
  *"mcp get plugin:sdlc:figma"*)
    printf '%s\n' 'plugin:sdlc:figma:' '  Status: ✓ Connected'
    exit 0
    ;;
  *"mcp login plugin:sdlc:figma"*)
    printf '%s\n' 'Open https://www.figma.com/oauth/authorize?client_id=test'
    exit 0
    ;;
esac
printf '%s\n' '{"tool_input":{"command":"git status"}}' \\
  | CLAUDE_PROJECT_DIR="$PWD" CLAUDE_PLUGIN_ROOT="$SDLC_TEST_PLUGIN_ROOT" \\
    "$SDLC_TEST_PLUGIN_ROOT/scripts/guard-git.sh"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-test"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"ToolSearch","input":{"query":"+bash shell command git"}}]}}'
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":[]}]}}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"agent-1","name":"Task","input":{"subagent_type":"sdlc:qa","description":"Auditar la historia"}}]}}'
printf '%s\n' '{"type":"assistant","parent_tool_use_id":"agent-1","message":{"content":[{"type":"text","text":"SDLC_PROGRESS {\\\"step\\\":2,\\\"total\\\":6,\\\"label\\\":\\\"Ejecutar la suite relevante\\\"}"}]}}'
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"agent-1","content":"{\\\"verdict\\\":\\\"PASS\\\"}"}]}}'
printf '%s\n' '{"type":"assistant","message":{"id":"msg-usage","usage":{"input_tokens":120,"output_tokens":30,"cache_read_input_tokens":400},"content":[{"type":"text","text":"Listo"}]}}'
mkdir -p ".claude/run/$SDLC_STORY_ID"
printf '%s\n' '%PDF-1.4' 'reporte de prueba' '%%EOF' > ".claude/run/$SDLC_STORY_ID/report.pdf"
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
      SDLC_TEST_PLUGIN_ROOT: path.join(ROOT, 'plugins/sdlc'),
    },
    stdio: 'ignore',
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitFor(`${baseUrl}/api/plugin`);
    const home = await fetch(baseUrl).then(r => r.text());
    assert.match(home, /Conectar Figma/);
    assert.doesNotMatch(home, /URL completa del callback|Abrir autenticación/);
    assert.match(home, /window\.open\('about:blank', `sdlc-\$\{server\}-oauth`\)/);
    assert.match(home, /ev\.t === 'url'/);
    assert.doesNotMatch(home, /async function open\(/);
    assert.match(home, /Proyecto existente/);
    assert.match(home, /Proyecto nuevo/);
    assert.match(home, /Informes de corridas/);
    assert.match(home, /const CAMPOS = \['source', 'story', 'repoDir', 'baseBranch', 'repoScope'/);
    assert.match(home, /Ciclos de desarrollo/);
    assert.match(home, /Flujo normal: \$\{initial\}/);
    assert.match(home, /Correctivos: \$\{round\} de \$\{max\}/);
    assert.match(home, /deshabilitado · no participa/);
    assert.doesNotMatch(home, /gloop-source/);
    assert.match(home, /Crear y asociar/);
    const plugin = await fetch(`${baseUrl}/api/plugin`).then(r => r.json());
    assert.equal(plugin.targetRepo, path.resolve(repo));
    assert.equal(plugin.targetRepoExplicit, true);
    assert.equal(plugin.agents.find(a => a.name === 'qa').progressSteps.length, 6);
    const prepare = await fetch(`${baseUrl}/api/repo/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: path.join(repo, 'apps/web') }),
    }).then(r => r.json());
    assert.equal(prepare.dir, fs.realpathSync(repo));
    assert.ok(prepare.workspaces.includes('apps/web'));

    const created = await fetch(`${baseUrl}/api/repo/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', url: 'proyecto-vacio' }),
    }).then(r => r.json());
    assert.equal(created.created, true);
    assert.equal(created.dir, path.join(workspace, 'proyecto-vacio'));
    assert.deepEqual(created.workspaces, ['.']);
    assert.ok(created.branches.includes('main'));
    assert.ok(fs.existsSync(path.join(created.dir, '.git')));

    const duplicate = await fetch(`${baseUrl}/api/repo/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', url: 'proyecto-vacio' }),
    });
    assert.equal(duplicate.status, 409);

    const traversal = await fetch(`${baseUrl}/api/repo/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'new', url: '../fuera' }),
    });
    assert.equal(traversal.status, 400);

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

    const mcpStatus = await fetch(`${baseUrl}/api/mcp/status?server=figma`).then(r => r.json());
    assert.equal(mcpStatus.status, 'connected');
    assert.equal(mcpStatus.qualified, 'plugin:sdlc:figma');
    const mcpLogin = await fetch(`${baseUrl}/api/mcp/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server: 'figma' }),
    });
    assert.equal(mcpLogin.status, 200);
    const mcpStream = await fetch(`${baseUrl}/api/mcp/stream`).then(r => r.text());
    assert.match(mcpStream, /"t":"url"/);
    assert.match(mcpStream, /figma\.com\/oauth\/authorize/);
    assert.match(mcpStream, /"status":"connected"/);

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
      assert.equal(info.sourceRepo, fs.realpathSync(repo));
      assert.equal(info.scope, 'apps/web');
      assert.equal(info.baseBranch, 'main');
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
    assert.match(stream, /"t":"agent_progress","agent":"qa","phase":5,"step":2,"total":6/);
    assert.match(stream, /--forward-subagent-text/);
    assert.match(stream, /"tokenUsage":\{"input":120,"output":30,"cacheRead":400,"cacheWrite":0\}/);
    assert.match(stream, /"usagePlan":\{"kind":"subscription","label":"Crédito mensual SDK"\}/);

    const reportBytes = Buffer.from('%PDF-1.4\nreporte de prueba\n%%EOF\n');
    const report = await fetch(`${baseUrl}/api/run/${run.runId}/report`);
    assert.equal(report.status, 200);
    assert.equal(report.headers.get('content-type'), 'application/pdf');
    assert.match(report.headers.get('content-disposition'), /LOCAL-1-sdlc-report\.pdf/);
    assert.deepEqual(Buffer.from(await report.arrayBuffer()), reportBytes);
    const archivedDir = path.join(repo, 'apps/web/.claude/run/LOCAL-1/reports');
    assert.equal(fs.readdirSync(archivedDir).filter(file => file.endsWith('.pdf')).length, 1);
    const scopedHistory = await fetch(`${baseUrl}/api/reports?${new URLSearchParams({ repoDir: repo, scope: 'apps/web' })}`).then(r => r.json());
    assert.equal(scopedHistory.reports.filter(item => item.storyId === 'LOCAL-1').length, 1);

    const historyDir = path.join(repo, '.claude/run/HIST-1');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, 'story.json'), JSON.stringify({ id: 'HIST-1', title: 'Informe histórico', tracker: 'manual' }));
    fs.writeFileSync(path.join(historyDir, 'report.pdf'), reportBytes);
    const history = await fetch(`${baseUrl}/api/reports?repoDir=${encodeURIComponent(repo)}`).then(r => r.json());
    const saved = history.reports.find(item => item.storyId === 'HIST-1');
    assert.ok(saved);
    assert.equal(saved.title, 'Informe histórico');
    const savedReport = await fetch(`${baseUrl}/api/reports/download?${new URLSearchParams({
      repoDir: repo, storyId: 'HIST-1', file: 'report.pdf',
    })}`);
    assert.equal(savedReport.status, 200);
    assert.deepEqual(Buffer.from(await savedReport.arrayBuffer()), reportBytes);
  } finally {
    const closed = new Promise(resolve => server.once('close', resolve));
    server.kill('SIGTERM');
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 1000))]);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
