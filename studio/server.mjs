#!/usr/bin/env node
/**
 * globant-sdlc studio — servidor local.
 *
 * Sin dependencias npm: solo built-ins de Node. En un entorno corporativo eso
 * significa que no hay supply chain que revisar antes de que el equipo lo use.
 *
 *   node studio/server.mjs [--plugin <dir>] [--repo <dir>] [--port 4477]
 *
 * Escucha SOLO en 127.0.0.1. No exponerlo en una interfaz de red: el endpoint
 * de run ejecuta el binario `claude` en la máquina donde corre.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------- argumentos

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PLUGIN_DIR = path.resolve(arg('plugin', path.join(REPO_ROOT, 'plugins/globant-sdlc')));
const TARGET_REPO = path.resolve(arg('repo', process.env.GLOBANT_TARGET_REPO || process.cwd()));
const PORT = Number(arg('port', 4477));
const PUBLIC_DIR = path.join(HERE, 'public');

// Extensiones editables. Todo lo demás es de solo lectura desde el studio.
const EDITABLE = new Set(['.md', '.json', '.sh', '.yml', '.yaml']);

/**
 * Nombre del plugin, leído del manifest.
 *
 * Hace falta porque las skills y los subagentes de un plugin se invocan
 * calificados con él: `/globant-sdlc:us`, no `/us`. Sin el prefijo, Claude
 * responde "Unknown command".
 */
const PLUGIN_NAME = (() => {
  try {
    const file = path.join(PLUGIN_DIR, '.claude-plugin/plugin.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).name || null;
  } catch {
    return null;
  }
})();

/** `us` → `globant-sdlc:us`. Sin manifest legible cae al nombre suelto. */
const qualify = name => (PLUGIN_NAME ? `${PLUGIN_NAME}:${name}` : name);

/** `globant-sdlc:refinamiento` → `refinamiento`, para mapear contra AGENT_PHASE. */
const unqualify = name => String(name).slice(String(name).indexOf(':') + 1);

// ------------------------------------------------------------------ helpers

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
};

/** Resuelve una ruta relativa contra el plugin y verifica que no se escape. */
function safePath(rel) {
  const abs = path.resolve(PLUGIN_DIR, rel);
  const root = PLUGIN_DIR.endsWith(path.sep) ? PLUGIN_DIR : PLUGIN_DIR + path.sep;
  if (abs !== PLUGIN_DIR && !abs.startsWith(root)) {
    throw Object.assign(new Error('ruta fuera del plugin'), { code: 403 });
  }
  return abs;
}

async function readBody(req, limit = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('body demasiado grande'), { code: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parser de frontmatter para el subconjunto plano que usan estos archivos:
 * `clave: valor` y listas inline `[a, b]`. No es YAML completo — si el archivo
 * usa estructuras anidadas, el frontmatter se devuelve como texto crudo y la UI
 * cae al editor plano.
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: null, raw: '', body: text, flat: true };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: null, raw: '', body: text, flat: true };

  const raw = text.slice(4, end);
  // Se sacan TODOS los saltos iniciales, no uno: `compose()` en el front vuelve
  // a unir con `\n\n`, y si acá queda uno de más el archivo no round-trippea —
  // el editor se marcaba sucio al abrir y al guardar sumaba una línea vacía.
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const data = {};
  let flat = true;

  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) { flat = false; continue; }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) { flat = false; continue; }
    let [, key, value] = m;
    value = value.trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      data[key] = value.replace(/^["']|["']$/g, '');
    }
  }
  return { data, raw, body, flat };
}

/** Corre un subcomando de `claude` y junta su salida. Para comandos cortos. */
function runClaude(args, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const c = spawn('claude', args, { cwd });
    c.stdout.on('data', d => stdout += d);
    c.stderr.on('data', d => stderr += d);
    c.on('error', e => resolve({
      code: -1,
      stdout: '',
      stderr: e.code === 'ENOENT' ? 'No se encontró el binario `claude` en el PATH.' : e.message,
    }));
    c.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const listDir = async (dir, filter = () => true) => {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter(d => d.isFile() && filter(d.name))
      .map(d => d.name)
      .sort();
  } catch { return []; }
};

// ---------------------------------------------------------- escaneo del plugin

async function scanPlugin() {
  const rel = p => path.relative(PLUGIN_DIR, p).split(path.sep).join('/');
  const out = {
    pluginDir: PLUGIN_DIR,
    targetRepo: TARGET_REPO,
    manifest: null,
    skills: [],
    agents: [],
    hooks: [],
    scripts: [],
    mcp: [],
    problems: [],
  };

  // manifest
  const manifestPath = path.join(PLUGIN_DIR, '.claude-plugin/plugin.json');
  try {
    out.manifest = {
      path: rel(manifestPath),
      data: JSON.parse(await fsp.readFile(manifestPath, 'utf8')),
    };
  } catch (e) {
    out.problems.push(`No se pudo leer plugin.json: ${e.message}`);
  }

  // skills
  const skillsDir = path.join(PLUGIN_DIR, 'skills');
  let skillNames = [];
  try {
    skillNames = (await fsp.readdir(skillsDir, { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch { /* sin skills */ }

  for (const name of skillNames) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    try {
      const text = await fsp.readFile(file, 'utf8');
      const fm = parseFrontmatter(text);
      const refDir = path.join(skillsDir, name, 'references');
      const refs = (await listDir(refDir)).map(f => ({
        name: f, path: rel(path.join(refDir, f)),
      }));
      out.skills.push({
        kind: 'skill',
        name: fm.data?.name || name,
        // Con el que se invoca de verdad. Escribir `/us` da "Unknown command".
        command: qualify(fm.data?.name || name),
        path: rel(file),
        description: fm.data?.description || '',
        bytes: Buffer.byteLength(text),
        references: refs,
      });
    } catch (e) {
      out.problems.push(`skills/${name}: ${e.message}`);
    }
  }

  // agentes
  const agentsDir = path.join(PLUGIN_DIR, 'agents');
  for (const f of await listDir(agentsDir, n => n.endsWith('.md'))) {
    const file = path.join(agentsDir, f);
    try {
      const fm = parseFrontmatter(await fsp.readFile(file, 'utf8'));
      const d = fm.data || {};
      const denied = Array.isArray(d.disallowedTools)
        ? d.disallowedTools
        : String(d.disallowedTools || '').split(',').map(s => s.trim()).filter(Boolean);
      out.agents.push({
        kind: 'agent',
        name: d.name || f.replace(/\.md$/, ''),
        qualifiedName: qualify(d.name || f.replace(/\.md$/, '')),
        path: rel(file),
        description: d.description || '',
        model: d.model || '(heredado)',
        effort: d.effort || null,
        maxTurns: d.maxTurns || null,
        readOnly: denied.includes('Write') && denied.includes('Edit'),
        disallowedTools: denied,
      });
    } catch (e) {
      out.problems.push(`agents/${f}: ${e.message}`);
    }
  }

  // hooks
  const hooksPath = path.join(PLUGIN_DIR, 'hooks/hooks.json');
  try {
    const data = JSON.parse(await fsp.readFile(hooksPath, 'utf8'));
    for (const [event, entries] of Object.entries(data.hooks || {})) {
      for (const entry of entries) {
        for (const h of entry.hooks || []) {
          const cmd = String(h.command || '');
          const scriptName = (cmd.match(/([A-Za-z0-9._-]+\.sh)/) || [])[1] || null;
          out.hooks.push({
            kind: 'hook',
            event,
            matcher: entry.matcher || '*',
            description: h.description || '',
            script: scriptName,
            scriptPath: scriptName ? `scripts/${scriptName}` : null,
            path: rel(hooksPath),
          });
        }
      }
    }
  } catch (e) {
    out.problems.push(`hooks.json: ${e.message}`);
  }

  // scripts
  const scriptsDir = path.join(PLUGIN_DIR, 'scripts');
  for (const f of await listDir(scriptsDir, n => n.endsWith('.sh'))) {
    const file = path.join(scriptsDir, f);
    let executable = false;
    try { executable = ((await fsp.stat(file)).mode & 0o111) !== 0; } catch { /* noop */ }
    out.scripts.push({ kind: 'script', name: f, path: rel(file), executable });
    if (!executable) {
      out.problems.push(`scripts/${f} no tiene permiso de ejecución — el hook no va a disparar`);
    }
  }

  // mcp
  try {
    const data = JSON.parse(await fsp.readFile(path.join(PLUGIN_DIR, '.mcp.json'), 'utf8'));
    for (const [name, cfg] of Object.entries(data.mcpServers || {})) {
      out.mcp.push({
        kind: 'mcp',
        name,
        transport: cfg.type || (cfg.command ? 'stdio' : 'desconocido'),
        target: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '),
        path: '.mcp.json',
      });
    }
  } catch { /* opcional */ }

  return out;
}

// ------------------------------------------------------- historia manual

// Mismo patrón que valida el endpoint de run: sin puntos ni barras, así que no
// hay traversal posible por el ID. La verificación de contención igual está.
const STORY_ID_RE = /^#?[A-Za-z0-9-]{1,40}$/;

/** Resuelve `.claude/run/<ID>` dentro del repo objetivo y verifica que no se escape. */
function runDirFor(repoDir, storyId) {
  if (!STORY_ID_RE.test(storyId)) {
    throw Object.assign(new Error('ID de historia inválido'), { code: 400 });
  }
  const root = path.resolve(repoDir);
  const base = path.join(root, '.claude', 'run');
  const abs = path.resolve(base, storyId.replace(/^#/, ''));
  if (!abs.startsWith(base + path.sep)) {
    throw Object.assign(new Error('ruta de run fuera del repo'), { code: 403 });
  }
  return abs;
}

/** `Título de la historia` → `titulo-de-la-historia`, para derivar un ID legible. */
function slugify(s, max = 30) {
  const clean = String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (clean.length <= max) return clean;
  // Corta en el \u00faltimo guion: un ID partido a mitad de palabra se lee como error.
  const cut = clean.slice(0, max);
  return cut.slice(0, cut.lastIndexOf('-')).replace(/-+$/, '') || cut;
}

/** Acepta un array o un texto con un ítem por línea, tolerando viñetas. */
const toList = (v, sep) => (Array.isArray(v) ? v : String(v || '').split(sep))
  .map(s => String(s).replace(/^\s*[-*]\s*/, '').trim())
  .filter(Boolean);

/**
 * Escribe una historia tipeada a mano con el esquema canónico de `story.json`.
 *
 * Es el camino para equipos que no integran con ningún tracker: la historia la
 * escribe el dev en el studio y de ahí en adelante el ciclo es idéntico. Nada
 * downstream sabe que no vino de Jira — por eso se escribe el esquema completo,
 * con los campos que no aplican en null, y no una versión recortada.
 *
 * No valida los criterios de aceptación: eso lo decide `refinamiento`, que es el
 * circuit breaker del flujo. Escribir la historia acá no saltea ese gate.
 */
async function writeManualStory(repoDir, input) {
  const title = String(input.title || '').trim();
  if (!title) {
    throw Object.assign(new Error('La historia necesita un título'), { code: 400 });
  }

  let id = String(input.id || '').trim().replace(/^#/, '');
  if (!id) id = `LOCAL-${slugify(title) || Math.random().toString(36).slice(2, 8)}`;
  if (!STORY_ID_RE.test(id)) {
    throw Object.assign(new Error(`ID de historia inválido: ${id}`), { code: 400 });
  }

  const points = Number(input.storyPoints);
  const story = {
    id,
    tracker: 'manual',
    url: null,
    type: 'story',
    title,
    description: String(input.description || '').trim(),
    acceptance_criteria: toList(input.acceptanceCriteria, '\n'),
    story_points: Number.isFinite(points) && points > 0 ? points : null,
    epic: null,
    labels: toList(input.labels, ','),
    attachments: [],
    linked_issues: [],
    repo_hint: null,
    raw: { source: 'studio', authored_at: new Date().toISOString() },
  };

  const dir = runDirFor(repoDir, id);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'story.json');
  await fsp.writeFile(file, JSON.stringify(story, null, 2) + '\n', 'utf8');
  return { id, file, story };
}

// ------------------------------------------------------------------- auth

/** Manda un evento a los clientes SSE de un canal y lo guarda para los que lleguen tarde. */
function push(channel, event, cap = 3000) {
  channel.events.push(event);
  if (channel.events.length > cap) channel.events.shift();
  for (const res of channel.clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * El login de `claude` es un flujo OAuth por browser: el proceso imprime una URL
 * y espera. Como el studio ya corre en la máquina del dev y se ve en un browser,
 * alcanza con levantar el proceso, mostrar la URL y poder escribirle a stdin
 * (algunos flujos piden pegar un código de vuelta).
 *
 * Es un proceso único: dos logins en paralelo compiten por las mismas credenciales.
 */
const login = { child: null, status: 'idle', events: [], clients: new Set() };

async function authStatus() {
  const { code, stdout, stderr } = await runClaude(['auth', 'status', '--json']);
  try {
    return { ok: true, ...JSON.parse(stdout) };
  } catch {
    return {
      ok: false,
      loggedIn: false,
      error: (stderr || stdout || `exit ${code}`).trim().slice(0, 400),
    };
  }
}

function startLogin(mode) {
  if (login.child) return { already: true };

  const args = ['auth', 'login'];
  if (mode === 'console') args.push('--console');
  if (mode === 'sso') args.push('--sso');

  login.events = [];
  login.status = 'running';
  push(login, { t: 'start', cmd: `claude ${args.join(' ')}`, at: Date.now() });

  const child = spawn('claude', args, { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  login.child = child;

  // La URL es lo único que el dev necesita del stream: se emite aparte para que
  // la UI la muestre como link en vez de hacerlo cazarla en el texto.
  const scan = (text, kind) => {
    push(login, { t: kind, text: text.slice(0, 2000), at: Date.now() });
    for (const url of text.match(/https?:\/\/[^\s'"]+/g) || []) {
      push(login, { t: 'url', url, at: Date.now() });
    }
  };

  child.stdout.on('data', d => scan(d.toString('utf8'), 'out'));
  child.stderr.on('data', d => scan(d.toString('utf8'), 'out'));
  child.on('error', e => {
    login.status = 'error';
    push(login, {
      t: 'error',
      message: e.code === 'ENOENT' ? 'No se encontró el binario `claude` en el PATH.' : e.message,
      at: Date.now(),
    });
  });
  child.on('close', async (code) => {
    login.child = null;
    login.status = code === 0 ? 'done' : 'error';
    const status = await authStatus();
    push(login, { t: 'end', code, status: login.status, auth: status, at: Date.now() });
    for (const res of login.clients) res.end();
    login.clients.clear();
  });

  return { already: false };
}

// ------------------------------------------------------------------- runs

/** Fases del skill `us`. El orden es el del SKILL.md. */
const PHASES = [
  { id: 0, key: 'resolver',       label: 'Resolver historia', gate: false },
  { id: 1, key: 'refinamiento',   label: 'Refinamiento',      gate: true  },
  { id: 2, key: 'arquitectura',   label: 'Arquitectura',      gate: true  },
  { id: 3, key: 'implementacion', label: 'Implementación',    gate: false },
  { id: 4, key: 'verificacion',   label: 'Verificación',      gate: false },
  { id: 5, key: 'revision',       label: 'Revisión',          gate: false },
  { id: 6, key: 'pr',             label: 'Pull Request',      gate: false },
];

const AGENT_PHASE = {
  refinamiento: 1, arquitectura: 2, qa: 4, seguridad: 4, reviewer: 5,
};

const runs = new Map();

function emit(run, event) {
  run.events.push(event);
  if (run.events.length > 3000) run.events.shift();
  for (const res of run.clients) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

/**
 * Resumen corto de una llamada a herramienta, para que el log muestre qué está
 * haciendo el run y no solo en qué fase va.
 */
function toolSummary(name, input = {}) {
  if (name === 'Bash') return String(input.command || '');
  if (name === 'Task') {
    const agent = input.subagent_type || input.agent || '?';
    return `@${agent}${input.description ? ` — ${input.description}` : ''}`;
  }
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    return String(input.file_path || input.notebook_path || '');
  }
  if (['Glob', 'Grep'].includes(name)) return String(input.pattern || '');
  if (name === 'WebFetch' || name === 'WebSearch') return String(input.url || input.query || '');
  const [first] = Object.keys(input);
  return first ? `${first}: ${String(input[first])}` : '';
}

/** Deriva la fase actual a partir de un evento del stream. Es inferencia. */
function inferPhase(run, msg) {
  const blocks = msg?.message?.content;
  if (!Array.isArray(blocks)) return;

  for (const b of blocks) {
    if (b.type === 'tool_use') {
      const name = b.name;
      const input = b.input || {};

      emit(run, {
        t: 'tool', name, summary: toolSummary(name, input).slice(0, 400), at: Date.now(),
      });

      if (name === 'Task') {
        // Los subagentes de un plugin llegan calificados: `globant-sdlc:qa`.
        const agent = unqualify(String(input.subagent_type || input.agent || '').toLowerCase());
        const phase = AGENT_PHASE[agent];
        if (phase !== undefined) {
          setPhase(run, phase, `@${agent}`);
          emit(run, { t: 'agent', agent, phase, at: Date.now() });
        }
        continue;
      }
      if (name === 'Bash') {
        const cmd = String(input.command || '');
        if (cmd.includes('resolve-story.sh')) setPhase(run, 0, 'resolve-story.sh');
        else if (/\b(gh pr create|az repos pr create|glab mr create)\b/.test(cmd)) setPhase(run, 6, 'abriendo PR');
        continue;
      }
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
        // Escribir dentro de `.claude/run/<ID>/` es dejar evidencia del run
        // —story.json, plan.md, blocked.md—, no implementar la historia. Sin
        // esta excepción, el `blocked.md` que escribe el corte de refinamiento
        // hacía avanzar la vía a "implementando", que es lo contrario de lo
        // que acababa de pasar.
        const target = String(input.file_path || input.notebook_path || '');
        const esEvidencia = /[\\/]\.claude[\\/]run[\\/]/.test(target);
        if (!esEvidencia && run.phase !== null && run.phase < 3) {
          setPhase(run, 3, 'implementando');
        }
      }
    }

    // Los agentes devuelven JSON con `verdict`. Un bloqueo detiene el run.
    if (b.type === 'tool_result' || b.type === 'text') {
      const text = typeof b.content === 'string' ? b.content
        : typeof b.text === 'string' ? b.text
        : Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : '';
      if (/"verdict"\s*:\s*"BLOCKED"/.test(text)) {
        run.blocked = { phase: 1, reason: 'La historia no pasó refinamiento' };
        emit(run, { t: 'blocked', ...run.blocked, at: Date.now() });
      } else if (/blast_radius\s*:?\s*"?high/i.test(text)) {
        run.blocked = { phase: 2, reason: 'blast_radius alto — requiere revisión humana' };
        emit(run, { t: 'blocked', ...run.blocked, at: Date.now() });
      }
    }
  }
}

function setPhase(run, phase, detail) {
  if (run.phase === phase) return;
  // Un run bloqueado no avanza más. El corte es terminal por diseño (D2), y
  // mostrar la vía progresando después de un bloqueo comunica exactamente lo
  // contrario de lo que hizo el circuit breaker.
  if (run.blocked) return;
  run.phase = phase;
  run.phaseHistory.push({ phase, detail, at: Date.now() });
  emit(run, { t: 'phase', phase, detail, at: Date.now() });
}

/** Confirma el avance leyendo los artefactos que el flujo deja en disco. */
async function pollArtifacts(run) {
  if (!run.storyId) return; // sesión de consola: no hay run de historia que auditar
  const dir = path.join(TARGET_REPO, '.claude/run', run.storyId);
  const map = [
    ['story.json', 0], ['plan.md', 2], ['qa.json', 4],
    ['security.json', 4], ['review.json', 5],
  ];
  for (const [file, phase] of map) {
    if (run.artifacts[file]) continue;
    try {
      const st = await fsp.stat(path.join(dir, file));
      // El directorio del run sobrevive entre corridas: un `qa.json` de ayer
      // encendería una fase que hoy todavía no ocurrió. Solo cuentan los
      // archivos que escribió ESTE run. La tolerancia cubre el `story.json`
      // que el studio deja en disco justo antes de arrancar el proceso.
      if (st.mtimeMs < run.startedAt - 5000) continue;
      run.artifacts[file] = true;
      emit(run, { t: 'artifact', file, phase, at: Date.now() });
    } catch { /* todavía no existe */ }
  }
}

/**
 * Manda un turno de usuario a una sesión abierta.
 *
 * Con `--input-format stream-json` el proceso no termina cuando responde: queda
 * esperando más mensajes por stdin. Eso es lo que convierte al panel de ejecución
 * en una consola — el dev puede seguir la conversación donde el run la dejó, en
 * la misma sesión y con el mismo contexto.
 */
function sendToRun(run, text) {
  if (!run.child || run.stdinClosed) {
    throw Object.assign(new Error('la sesión ya está cerrada'), { code: 409 });
  }
  run.child.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n');
  run.status = 'running';
  emit(run, { t: 'ask', text: text.slice(0, 2000), at: Date.now() });
}

function startRun({ storyId, repoDir, manual, permissionMode, extraFlags }) {
  const id = randomUUID();
  // El tracker va explícito: story.json ya dice `manual`, pero decirlo también en
  // la invocación evita que el resolver tenga que adivinar por la forma del ID.
  // Sin storyId es una sesión de consola: se abre vacía y la maneja el dev.
  const skill = `/${qualify('us')}`;
  const prompt = storyId
    ? (manual ? `${skill} ${storyId} --tracker manual` : `${skill} ${storyId}`)
    : null;

  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // Sin esto la sesión corre en el repo objetivo sin el plugin cargado, y
    // `/globant-sdlc:us` no existe. Además hace que corra lo que hay en disco,
    // que es lo que el studio deja editar.
    '--plugin-dir', PLUGIN_DIR,
  ];
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (extraFlags) args.push(...extraFlags.split(/\s+/).filter(Boolean));

  const run = {
    id, storyId, prompt, args, cwd: repoDir,
    startedAt: Date.now(), status: 'running',
    phase: null, phaseHistory: [], blocked: null,
    artifacts: {}, events: [], clients: new Set(), child: null, stdinClosed: false,
  };
  runs.set(id, run);

  let child;
  try {
    child = spawn('claude', args, { cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    run.status = 'error';
    emit(run, { t: 'error', message: `No se pudo ejecutar \`claude\`: ${e.message}`, at: Date.now() });
    return run;
  }
  run.child = child;
  child.stdin.on('error', () => { /* la sesión se cerró del otro lado */ });

  emit(run, { t: 'start', storyId, cwd: repoDir, cmd: `claude ${args.join(' ')}`, at: Date.now() });

  if (prompt) sendToRun(run, prompt);
  else {
    run.status = 'idle';
    emit(run, { t: 'ready', at: Date.now() });
  }

  child.on('error', (e) => {
    run.status = 'error';
    emit(run, {
      t: 'error',
      message: e.code === 'ENOENT'
        ? 'No se encontró el binario `claude` en el PATH.'
        : e.message,
      at: Date.now(),
    });
  });

  let buf = '';
  child.stdout.on('data', async (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type === 'system' && msg.subtype === 'init') {
        run.sessionId = msg.session_id || null;
        emit(run, { t: 'init', sessionId: run.sessionId, at: Date.now() });
      } else if (msg.type === 'assistant') {
        inferPhase(run, msg);
        const text = (msg.message?.content || [])
          .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (text) emit(run, { t: 'say', text: text.slice(0, 1200), at: Date.now() });
      } else if (msg.type === 'user') {
        inferPhase(run, msg);
      } else if (msg.type === 'result') {
        run.cost = msg.total_cost_usd ?? run.cost ?? null;
        run.turns = msg.num_turns ?? null;
        // Terminó el turno, no la sesión: queda esperando el próximo mensaje.
        run.status = run.stdinClosed ? 'done' : 'idle';
        emit(run, {
          t: 'result',
          ok: !msg.is_error,
          status: run.status,
          cost: run.cost,
          turns: run.turns,
          text: typeof msg.result === 'string' ? msg.result.slice(0, 4000) : null,
          at: Date.now(),
        });
      }
    }
    await pollArtifacts(run);
  });

  child.stderr.on('data', (chunk) => {
    emit(run, { t: 'stderr', text: chunk.toString('utf8').slice(0, 800), at: Date.now() });
  });

  child.on('close', (code) => {
    if (run.status !== 'stopped') run.status = code === 0 ? 'done' : 'error';
    emit(run, { t: 'end', code, status: run.status, at: Date.now() });
    for (const res of run.clients) res.end();
    run.clients.clear();
  });

  return run;
}

// ----------------------------------------------------------------- servidor

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  try {
    // --- API ---
    if (p === '/api/plugin' && req.method === 'GET') {
      return json(res, 200, await scanPlugin());
    }

    if (p === '/api/phases' && req.method === 'GET') {
      return json(res, 200, { phases: PHASES, agentPhase: AGENT_PHASE });
    }

    if (p === '/api/file' && req.method === 'GET') {
      const abs = safePath(url.searchParams.get('path') || '');
      const text = await fsp.readFile(abs, 'utf8');
      const fm = parseFrontmatter(text);
      return json(res, 200, {
        path: url.searchParams.get('path'),
        content: text,
        editable: EDITABLE.has(path.extname(abs)),
        frontmatter: fm.flat ? fm.data : null,
        body: fm.flat && fm.data ? fm.body : null,
      });
    }

    if (p === '/api/file' && req.method === 'PUT') {
      const { path: rel, content } = JSON.parse(await readBody(req));
      const abs = safePath(rel || '');
      if (!EDITABLE.has(path.extname(abs))) {
        return json(res, 403, { error: 'Tipo de archivo no editable desde el studio' });
      }
      const before = await fsp.stat(abs).catch(() => null);
      await fsp.writeFile(abs, content, 'utf8');
      if (before) await fsp.chmod(abs, before.mode); // preserva el bit +x
      return json(res, 200, { ok: true, bytes: Buffer.byteLength(content) });
    }

    if (p === '/api/validate' && req.method === 'POST') {
      return json(res, 200, await runClaude(['plugin', 'validate', PLUGIN_DIR, '--strict']));
    }

    // --- autenticación ---
    if (p === '/api/auth' && req.method === 'GET') {
      return json(res, 200, { ...await authStatus(), login: login.status });
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const { mode } = JSON.parse(await readBody(req) || '{}');
      const { already } = startLogin(mode);
      return json(res, already ? 409 : 200, already
        ? { error: 'ya hay un login en curso' }
        : { ok: true });
    }

    if (p === '/api/auth/input' && req.method === 'POST') {
      const { text } = JSON.parse(await readBody(req));
      if (!login.child) return json(res, 409, { error: 'no hay login en curso' });
      login.child.stdin.write(String(text ?? '') + '\n');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/auth/cancel' && req.method === 'POST') {
      login.child?.kill('SIGTERM');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const out = await runClaude(['auth', 'logout']);
      return json(res, 200, { ...out, auth: await authStatus() });
    }

    if (p === '/api/auth/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const ev of login.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (login.child) {
        login.clients.add(res);
        req.on('close', () => login.clients.delete(res));
      } else {
        res.end();
      }
      return;
    }

    if (p === '/api/story' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const repoDir = path.resolve(body.repoDir || TARGET_REPO);
      if (!fs.existsSync(repoDir)) {
        return json(res, 400, { error: `El directorio no existe: ${repoDir}` });
      }
      const { id, file, story } = await writeManualStory(repoDir, body);
      return json(res, 200, { id, path: file, story });
    }

    if (p === '/api/story' && req.method === 'GET') {
      const repoDir = path.resolve(url.searchParams.get('repoDir') || TARGET_REPO);
      const file = path.join(
        runDirFor(repoDir, String(url.searchParams.get('storyId') || '').trim()),
        'story.json',
      );
      try {
        return json(res, 200, { path: file, story: JSON.parse(await fsp.readFile(file, 'utf8')) });
      } catch {
        return json(res, 404, { error: 'No hay historia escrita para ese ID' });
      }
    }

    if (p === '/api/run' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const repoDir = path.resolve(body.repoDir || TARGET_REPO);
      if (!fs.existsSync(repoDir)) {
        return json(res, 400, { error: `El directorio no existe: ${repoDir}` });
      }

      // Sin historia es una sesión de consola: se abre vacía, sin invocar /us.
      const consoleMode = body.mode === 'console';

      // Con historia escrita a mano, se persiste antes de arrancar: el resolver
      // la encuentra en disco en la fase 0 y no consulta ningún tracker.
      let storyId = String(body.storyId || '').trim();
      const manual = !consoleMode && !!(body.story && typeof body.story === 'object');
      if (manual) {
        const story = { ...body.story, id: body.story.id || storyId };
        storyId = (await writeManualStory(repoDir, story)).id;
      }
      if (consoleMode) {
        storyId = null;
      } else if (!STORY_ID_RE.test(storyId)) {
        return json(res, 400, { error: 'ID de historia inválido' });
      }

      const run = startRun({
        storyId,
        repoDir,
        manual,
        permissionMode: body.permissionMode || null,
        extraFlags: body.extraFlags || '',
      });
      return json(res, 200, {
        runId: run.id,
        storyId,
        cmd: `claude ${run.args.join(' ')}`,
        prompt: run.prompt, // va por stdin, no en la línea de comandos
        cwd: repoDir,
      });
    }

    let m = p.match(/^\/api\/run\/([\w-]+)\/stream$/);
    if (m && req.method === 'GET') {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'run no encontrado' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      // Mientras el proceso viva la sesión sigue: `idle` es esperando input, no fin.
      if (run.child) {
        run.clients.add(res);
        req.on('close', () => run.clients.delete(res));
      } else {
        res.end();
      }
      return;
    }

    m = p.match(/^\/api\/run\/([\w-]+)\/send$/);
    if (m && req.method === 'POST') {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'run no encontrado' });
      const { text } = JSON.parse(await readBody(req));
      if (!String(text || '').trim()) return json(res, 400, { error: 'mensaje vacío' });
      sendToRun(run, String(text));
      return json(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/run\/([\w-]+)\/close$/);
    if (m && req.method === 'POST') {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'run no encontrado' });
      run.stdinClosed = true;
      run.child?.stdin.end();
      return json(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/run\/([\w-]+)\/stop$/);
    if (m && req.method === 'POST') {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'run no encontrado' });
      run.child?.kill('SIGTERM');
      run.status = 'stopped';
      emit(run, { t: 'end', code: null, status: 'stopped', at: Date.now() });
      return json(res, 200, { ok: true });
    }

    // --- estáticos ---
    const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
    const abs = path.resolve(PUBLIC_DIR, file);
    if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
    const data = await fsp.readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream' });
    return res.end(data);

  } catch (e) {
    if (e.code === 'ENOENT') { res.writeHead(404); return res.end('no encontrado'); }
    return json(res, typeof e.code === 'number' ? e.code : 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  globant-sdlc studio`);
  console.log(`  ───────────────────────────────────────────`);
  console.log(`  plugin : ${PLUGIN_DIR}`);
  console.log(`  repo   : ${TARGET_REPO}`);
  console.log(`  url    : http://127.0.0.1:${PORT}\n`);
});
