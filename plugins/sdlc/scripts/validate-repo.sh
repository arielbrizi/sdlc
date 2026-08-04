#!/usr/bin/env bash
# Verifica que la historia corresponda al repositorio/alcance activo.
set -euo pipefail

ID="${1:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STORY="${PROJECT_DIR}/.claude/run/${ID#\#}/story.json"
CONTEXT="${PROJECT_DIR}/.claude/run/${ID#\#}/repo-context.json"

[[ -f "$STORY" ]] || { echo "error: no existe ${STORY}" >&2; exit 2; }

node - "$STORY" "$CONTEXT" "$PROJECT_DIR" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [storyFile, contextFile, projectDir] = process.argv.slice(2);
const story = JSON.parse(fs.readFileSync(storyFile, 'utf8'));
let context = {};
try { context = JSON.parse(fs.readFileSync(contextFile, 'utf8')); } catch {}

const git = args => {
  try { return cp.execFileSync('git', ['-C', projectDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const normalize = value => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\.git$/i, '').replace(/[^a-z0-9]+/g, '');
const root = git(['rev-parse', '--show-toplevel']);
const remote = git(['remote', 'get-url', 'origin']);
const remoteName = remote.replace(/\.git$/i, '').replace(/\/+$/, '').split(/[/:]/).filter(Boolean).at(-1);
const names = [...new Set([
  ...(Array.isArray(context.names) ? context.names : []),
  root && path.basename(root), path.basename(projectDir), remoteName,
].filter(Boolean))];
const hints = (Array.isArray(story.repo_hint) ? story.repo_hint : String(story.repo_hint || '').split(','))
  .map(v => String(v).trim()).filter(Boolean);

if (hints.length > 1) {
  console.error(`error: la historia ${story.id} declara varios repos (${hints.join(', ')}). Un run automático produce una branch y un PR; dividí el alcance por repo.`);
  process.exit(2);
}
if (hints.length === 1) {
  const expected = normalize(hints[0]);
  const match = names.some(name => {
    const actual = normalize(name);
    return actual === expected || actual.includes(expected) || expected.includes(actual);
  });
  if (!match) {
    console.error(`error: la historia ${story.id} indica repo_hint=${hints[0]}, pero el run está en ${names.join(', ') || projectDir}`);
    process.exit(2);
  }
}

context = {
  ...context,
  source_repo: context.source_repo || root || projectDir,
  working_repo: context.working_repo || root || projectDir,
  scope: context.scope || path.relative(root || projectDir, projectDir) || '.',
  names,
  remote: context.remote || remote || null,
  repo_hint: hints[0] || null,
  repo_hint_status: hints.length ? 'match' : 'not_provided',
};
fs.mkdirSync(path.dirname(contextFile), { recursive: true });
fs.writeFileSync(contextFile, `${JSON.stringify(context, null, 2)}\n`);
console.log(JSON.stringify(context));
NODE
