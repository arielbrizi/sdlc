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
import os from 'node:os';
import {
  RECOVERY_PROMPT,
  finalCycleCompletion,
  prCommand,
  prTool,
  technicalToolInterruption,
} from './run-signals.mjs';

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
// Dónde se clonan los repos que se piden por URL. Fuera del repo del plugin a
// propósito: son repos de trabajo, no parte de este proyecto.
const WORKSPACE = path.resolve(
  arg('workspace', process.env.GLOBANT_WORKSPACE || path.join(os.homedir(), 'globant-sdlc-repos')),
);

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
const runClaude = (args, opts = {}) => runClaudeLike('claude', args, opts);

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
// ------------------------------------------- config del repo objetivo

/**
 * Qué agentes e integraciones tiene habilitados un repo.
 *
 * La resuelve el mismo `config.sh` que usa el ciclo, en vez de reimplementar los
 * defaults acá. Dos implementaciones del mismo default terminan divergiendo, y
 * el studio mostraría habilitado algo que el hook bloquea.
 */
function readProjectConfig(repoDir) {
  return new Promise((resolve, reject) => {
    const script = path.join(PLUGIN_DIR, 'scripts/config.sh');
    const child = spawn('bash', [script, 'json'], {
      cwd: repoDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repoDir, CLAUDE_PLUGIN_ROOT: PLUGIN_DIR },
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(err.trim() || `config.sh salió con ${code}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`config.sh no devolvió JSON: ${e.message}`)); }
    });
  });
}

/**
 * Escribe `.claude/globant-sdlc.json` en el repo objetivo.
 *
 * Se normaliza contra los agentes que existen en el plugin: un nombre que no
 * corresponde a ningún agente no se guarda. Sin eso, el archivo acumula claves
 * de agentes renombrados que nadie va a volver a mirar y que hacen creer que
 * algo está apagado cuando no existe.
 */
async function writeProjectConfig(repoDir, body) {
  const plugin = await scanPlugin();
  const conocidos = new Set(plugin.agents.map(a => a.name));
  const texto = (v, def = '') => (typeof v === 'string' ? v.trim() : def);

  const agents = {};
  for (const [nombre, valor] of Object.entries(body.agents || {})) {
    if (conocidos.has(nombre)) agents[nombre] = !!valor;
  }

  const figmaUrl = texto(body.figma?.url);
  let figmaFileKey = texto(body.figma?.file_key);
  let figmaNodeId = texto(body.figma?.node_id);
  if (figmaUrl) {
    let parsed;
    try { parsed = new URL(figmaUrl); }
    catch {
      throw Object.assign(new Error('El link de Figma no es válido. Copiá el link del frame seleccionado y pegalo completo.'), { code: 400 });
    }
    if (!/(^|\.)figma\.com$/i.test(parsed.hostname)) {
      throw Object.assign(new Error('El link debe ser de figma.com.'), { code: 400 });
    }
    const match = parsed.pathname.match(/^\/(?:design|file|proto)\/([^/]+)/i);
    if (!match) {
      throw Object.assign(new Error('No pude encontrar el archivo en ese link de Figma.'), { code: 400 });
    }
    figmaFileKey = match[1];
    figmaNodeId = texto(parsed.searchParams.get('node-id')).replace(/-/g, ':');
    if (!figmaNodeId) {
      throw Object.assign(new Error('El link no apunta a un frame. En Figma seleccioná la pantalla, elegí “Copy link to selection” y pegá ese link.'), { code: 400 });
    }
  }

  const cfg = {
    agents,
    figma: {
      enabled: !!figmaUrl || !!body.figma?.enabled,
      url: figmaUrl,
      file_key: figmaFileKey,
      node_id: figmaNodeId,
    },
    storybook: {
      enabled: !!body.storybook?.enabled,
      dir: texto(body.storybook?.dir, '.storybook') || '.storybook',
      url: texto(body.storybook?.url),
    },
  };

  const dir = path.join(path.resolve(repoDir), '.claude');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'globant-sdlc.json');
  await fsp.writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return file;
}

// ------------------------------------------------------- historia manual

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

// ------------------------------------------------------- repositorio y VCS

/**
 * De dónde sale el repositorio. Se acepta una URL o una carpeta local, y el
 * studio decide qué hacer: pegar una URL es lo que hace cualquiera que no
 * trabaja en la terminal, y obligar a clonar antes a mano era el escalón que
 * dejaba afuera a quien no es técnico.
 */
function parseRepoUrl(raw) {
  const url = String(raw || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!url) return { ok: false, error: 'falta la URL' };

  // Azure DevOps: https://dev.azure.com/<org>/<proyecto>/_git/<repo>
  let m = url.match(/^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i);
  if (m) return { ok: true, provider: 'azure', org: m[1], project: m[2], repo: m[3], url };

  // Azure DevOps viejo: https://<org>.visualstudio.com/<proyecto>/_git/<repo>
  m = url.match(/^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)$/i);
  if (m) return { ok: true, provider: 'azure', org: m[1], project: m[2], repo: m[3], url };

  // GitHub, https o ssh
  m = url.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+)$/i)
   || url.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (m) return { ok: true, provider: 'github', org: m[1], repo: m[2], url };

  // Cualquier otro remoto que git sepa clonar: GitLab, Bitbucket, un mirror
  // interno o un file:// local. No hay proveedor de credenciales conocido.
  if (/^(https?|ssh|git|file):\/\//i.test(url) || /^git@/.test(url)) {
    return { ok: true, provider: 'otro', org: null, repo: url.split('/').pop(), url };
  }
  return { ok: false, error: 'no parece una URL de repositorio ni una carpeta existente' };
}

/** Comando de login y de verificación por proveedor. */
const VCS = {
  github: {
    cli: 'gh',
    nombre: 'GitHub',
    status: ['auth', 'status'],
    login: ['auth', 'login', '--web', '--git-protocol', 'https'],
    instalar: 'brew install gh   (o https://cli.github.com)',
  },
  azure: {
    cli: 'az',
    nombre: 'Azure DevOps',
    status: ['account', 'show'],
    login: ['login'],
    instalar: 'brew install azure-cli   (o https://aka.ms/azure-cli)',
  },
};

/** ¿Hay credenciales para este proveedor? Lo contesta su propio CLI. */
async function vcsStatus(provider) {
  const cfg = VCS[provider];
  if (!cfg) return { provider, soportado: false, nombre: 'otro', loggedIn: null };

  const { code, stdout, stderr } = await runClaudeLike(cfg.cli, cfg.status);
  const salida = `${stdout}${stderr}`.trim();
  if (code === -1) {
    return {
      provider, soportado: true, nombre: cfg.nombre, cli: cfg.cli,
      instalado: false, loggedIn: false, instalar: cfg.instalar,
      detail: `${cfg.cli} no está instalado.`,
    };
  }
  return {
    provider, soportado: true, nombre: cfg.nombre, cli: cfg.cli,
    instalado: true, loggedIn: code === 0,
    detail: salida.slice(0, 400),
  };
}

/** Igual que runClaude pero con binario arbitrario. */
function runClaudeLike(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const c = spawn(bin, args, { cwd: REPO_ROOT, ...opts });
    c.stdout.on('data', d => stdout += d);
    c.stderr.on('data', d => stderr += d);
    c.on('error', () => resolve({ code: -1, stdout: '', stderr: `no se encontró ${bin}` }));
    c.on('close', code => resolve({ code, stdout, stderr }));
  });
}

// Login de VCS: mismo patrón que el de Claude — el flujo lo corre el CLI
// oficial y el studio muestra la URL y el código, y detecta cuándo terminó.
const vcsLogin = { child: null, status: 'idle', events: [], clients: new Set(), provider: null };

function startVcsLogin(provider) {
  const cfg = VCS[provider];
  if (!cfg) return { error: `proveedor no soportado: ${provider}` };
  if (vcsLogin.child) return { error: 'ya hay un login en curso' };

  vcsLogin.events = []; vcsLogin.status = 'running'; vcsLogin.provider = provider;
  push(vcsLogin, { t: 'start', cmd: `${cfg.cli} ${cfg.login.join(' ')}`, at: Date.now() });

  let child;
  try {
    child = spawn(cfg.cli, cfg.login, { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    vcsLogin.status = 'error';
    push(vcsLogin, { t: 'error', message: `${cfg.cli} no está instalado. ${cfg.instalar}`, at: Date.now() });
    return {};
  }
  vcsLogin.child = child;

  const scan = (text) => {
    push(vcsLogin, { t: 'out', text: text.slice(0, 2000), at: Date.now() });
    for (const url of text.match(/https?:\/\/[^\s'"]+/g) || []) {
      push(vcsLogin, { t: 'url', url, at: Date.now() });
    }
    // gh imprime un código de un solo uso que hay que pegar en el navegador.
    const codigo = text.match(/one-time code:\s*([A-Z0-9-]{6,})/i);
    if (codigo) push(vcsLogin, { t: 'code', code: codigo[1], at: Date.now() });
  };
  child.stdout.on('data', d => scan(d.toString('utf8')));
  child.stderr.on('data', d => scan(d.toString('utf8')));
  child.on('error', (e) => {
    vcsLogin.status = 'error';
    push(vcsLogin, { t: 'error', message: `${cfg.cli}: ${e.message}. ${cfg.instalar}`, at: Date.now() });
  });
  child.on('close', async (code) => {
    vcsLogin.child = null;
    vcsLogin.status = code === 0 ? 'done' : 'error';
    // Se vuelve a consultar el estado solo: el dev no tiene que confirmar nada.
    push(vcsLogin, { t: 'end', code, vcs: await vcsStatus(provider), at: Date.now() });
    for (const res of vcsLogin.clients) res.end();
    vcsLogin.clients.clear();
  });
  return {};
}

/**
 * Deja el repo listo en disco y devuelve sus branches. Clona la primera vez y
 * hace fetch después: reclonar en cada run sería lento y perdería el trabajo.
 */
async function prepararRepo(raw) {
  // Una carpeta local que ya existe se usa tal cual.
  const comoPath = path.resolve(String(raw || '').trim());
  if (fs.existsSync(path.join(comoPath, '.git'))) {
    return { dir: comoPath, clonado: false, ...(await ramas(comoPath)) };
  }

  const info = parseRepoUrl(raw);
  if (!info.ok) throw Object.assign(new Error(info.error), { code: 400 });

  const slug = [info.org, info.project, info.repo].filter(Boolean).join('__')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  const dir = path.join(WORKSPACE, slug);

  if (fs.existsSync(path.join(dir, '.git'))) {
    const r = await runClaudeLike('git', ['fetch', '--all', '--prune'], { cwd: dir });
    if (r.code !== 0) throw Object.assign(new Error(`git fetch falló: ${r.stderr.slice(0, 300)}`), { code: 502 });
    return { dir, clonado: false, provider: info.provider, ...(await ramas(dir)) };
  }

  await fsp.mkdir(WORKSPACE, { recursive: true });
  const r = await runClaudeLike('git', ['clone', info.url, dir], { cwd: WORKSPACE });
  if (r.code !== 0) {
    throw Object.assign(
      new Error(`git clone falló. ${r.stderr.slice(0, 400)}`),
      { code: 502 },
    );
  }
  return { dir, clonado: true, provider: info.provider, ...(await ramas(dir)) };
}

/** Branches remotas y la branch por defecto del repo. */
async function ramas(dir) {
  const limpiar = (salida, quitarRemoto) => salida.split('\n')
    .map(s => s.trim())
    // `origin/HEAD` se abrevia a `origin` a secas y no es una branch; los
    // punteros `a -> b` tampoco.
    .filter(s => s && !s.includes('->') && (!quitarRemoto || s.includes('/')))
    .map(s => (quitarRemoto ? s.replace(/^[^/]+\//, '') : s))
    .filter(s => s && s !== 'HEAD')
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();

  const remotas = await runClaudeLike('git', ['branch', '-r', '--format=%(refname:short)'], { cwd: dir });
  let branches = limpiar(remotas.stdout, true);

  // Un repo local sin remote configurado igual tiene branches locales, y son
  // las únicas contra las que se puede trabajar.
  if (!branches.length) {
    const locales = await runClaudeLike('git', ['branch', '--format=%(refname:short)'], { cwd: dir });
    branches = limpiar(locales.stdout, false);
  }

  const head = await runClaudeLike('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir });
  const porDefecto = head.code === 0
    ? head.stdout.trim().replace(/^origin\//, '')
    : ['main', 'master', 'develop'].find(b => branches.includes(b)) || branches[0] || null;

  return { branches, porDefecto };
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
  { id: 0, key: 'resolver',       label: 'Resolver historia',  gate: false },
  { id: 1, key: 'refinamiento',   label: 'Refinamiento',       gate: true  },
  { id: 2, key: 'arquitectura',   label: 'Arquitectura',       gate: true  },
  { id: 3, key: 'diseno',         label: 'Diseño de interfaz', gate: false, optional: true },
  { id: 4, key: 'implementacion', label: 'Implementación',     gate: false },
  { id: 5, key: 'verificacion',   label: 'Verificación',       gate: false },
  { id: 6, key: 'revision',       label: 'Revisión',           gate: false },
  { id: 7, key: 'pr',             label: 'Pull Request',       gate: false },
];

const AGENT_PHASE = {
  refinamiento: 1, arquitectura: 2, ux: 3, desarrollador: 4, qa: 5, seguridad: 5, reviewer: 6,
};

// La fase de PR y la primera que escribe código: las usa la inferencia, y sin
// nombrarlas quedaban como números sueltos que hay que recordar renumerar.
const PHASE_PR = 7;
const PHASE_IMPL = 4;

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
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const isSubagentTool = name => SUBAGENT_TOOLS.has(name);
const subagentName = input => unqualify(String(
  input.subagent_type || input.agent || input.name || '',
).toLowerCase());

function toolSummary(name, input = {}) {
  if (name === 'Bash') return String(input.command || '');
  if (isSubagentTool(name)) {
    return String(input.description || input.prompt || 'Trabajo delegado a un subagente');
  }
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    return String(input.file_path || input.notebook_path || '');
  }
  if (['Glob', 'Grep'].includes(name)) return String(input.pattern || '');
  if (name === 'WebFetch' || name === 'WebSearch') return String(input.url || input.query || '');
  const [first] = Object.keys(input);
  return first ? `${first}: ${String(input[first])}` : '';
}

/**
 * A qué nodo del grafo pertenece una llamada a herramienta.
 *
 * Es lo que permite que al hacer clic en `@qa` se vea lo que dijo `@qa`, y no
 * el log entero. Un subagente es su propio nodo; un script el suyo; el resto
 * cuelga de la fase en la que ocurrió.
 */
function nodeFor(run, name, input = {}) {
  if (isSubagentTool(name)) {
    return `agent:${subagentName(input) || 'desconocido'}`;
  }
  if (name === 'Bash') {
    const script = (String(input.command || '').match(/([A-Za-z0-9._-]+\.sh)/) || [])[1];
    if (script) return `script:${script}`;
  }
  return `phase:${run.phase ?? 0}`;
}

/** Texto plano de un bloque de contenido, venga como venga. */
function blockText(b) {
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(c => c.text || '').join('\n');
  return '';
}

/** Extrae la primera respuesta JSON de un subagente, incluso si vino en un fence. */
function agentJson(text) {
  const raw = String(text || '').replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(raw); } catch { /* puede venir acompañada de prosa */ }
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const BLOCK_REASON = {
  refinamiento: 'La historia necesita más definición',
  arquitectura: 'La arquitectura requiere una decisión humana',
  ux: 'El diseño de interfaz necesita más definición',
  desarrollador: 'La implementación necesita una decisión',
  qa: 'QA encontró problemas que hay que resolver',
  seguridad: 'Seguridad encontró problemas que hay que resolver',
  reviewer: 'La revisión pidió cambios',
};

function blockRun(run, { phase, agent, reason, questions = [], sourceId = null }) {
  if (run.blocked) return;
  const action = {
    id: sourceId ? `action:${sourceId}` : `action:${randomUUID()}`,
    phase, agent: agent || null, reason,
    questions: questions.filter(Boolean).map(String),
    status: 'open', createdAt: Date.now(),
  };
  run.actions.set(action.id, action);
  run.blocked = { phase, agent: agent || null, reason, actionId: action.id };
  emit(run, { t: 'action', ...action, at: action.createdAt });
  emit(run, { t: 'blocked', ...run.blocked, questions: action.questions, at: Date.now() });
}

/**
 * Un subagente puede declarar BLOCKED mientras el turno principal todavía está
 * procesando su resultado. La acción humana recién se publica cuando llega el
 * `result`: antes de eso Claude sigue trabajando y decir "te estamos esperando"
 * sería falso. Desde este punto sí congelamos la fase para que el mapa no avance.
 */
function queueBlock(run, block) {
  if (!run.pendingBlock && !run.blocked) run.pendingBlock = block;
}

/**
 * Una pregunta en el resultado final significa que el turno terminó esperando
 * al usuario. Claude no siempre la expresa mediante un subagente `BLOCKED`:
 * los pedidos de aprobación de permisos, por ejemplo, llegan como texto común.
 * Se detectan acá para que nunca se traduzcan como "sin acciones pendientes".
 */
function humanInputRequest(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  const lines = clean.split(/\n+/)
    .map(line => line.replace(/^\s*[-*#>]+\s*/, '').trim())
    .filter(Boolean);
  const questions = lines.filter(line => /[?？]/.test(line)).slice(-3);
  const approval = /(?:aprobaci[oó]n|aprobar|apruebo|aprob[aá]s|confirmaci[oó]n|confirm[aá]s|permiso para)/i.test(clean);
  const explicitRequest = /(?:para continuar|necesito que|indicame|ind[ií]came|respond[eé]|eleg[ií]|decid[ií])/i.test(clean);

  if (!questions.length && !approval && !explicitRequest) return null;
  return {
    reason: approval
      ? 'Claude necesita tu aprobación para continuar'
      : 'Claude necesita una respuesta tuya para continuar',
    questions: questions.length ? questions : [clean.slice(-600)],
  };
}

function completeCycle(run, detail = 'PR listo') {
  if (run.blocked || run.pendingBlock || run.cycleComplete) return false;
  setPhase(run, PHASE_PR, detail);
  run.cycleComplete = true;
  emit(run, { t: 'cycle_complete', phase: PHASE_PR, at: Date.now() });
  return true;
}

/** Deriva la fase actual a partir de un evento del stream. Es inferencia. */
function inferPhase(run, msg) {
  const blocks = msg?.message?.content;
  if (!Array.isArray(blocks)) return;

  for (const b of blocks) {
    if (b.type === 'tool_use') {
      const name = b.name;
      const input = b.input || {};

      // El nodo se recuerda por id para poder colgarle el resultado cuando llegue.
      const node = nodeFor(run, name, input);
      const agent = isSubagentTool(name)
        ? subagentName(input)
        : null;
      const pr = name === 'Bash' ? prCommand(input.command) : prTool(name);
      if (b.id) run.pending.set(b.id, {
        node, name, agent, isPr: pr.creates, touchesPr: pr.touches,
        phase: agent ? AGENT_PHASE[agent] : run.phase,
      });
      emit(run, {
        t: 'tool', name, node, agent, id: b.id || null,
        summary: toolSummary(name, input).slice(0, 400), at: Date.now(),
      });

      if (isSubagentTool(name)) {
        // Los subagentes de un plugin llegan calificados: `globant-sdlc:qa`.
        const phase = AGENT_PHASE[agent];
        if (phase !== undefined) {
          if (setPhase(run, phase, `@${agent}`)) {
            emit(run, { t: 'agent', agent, phase, at: Date.now() });
          }
        }
        continue;
      }
      if (name === 'Bash') {
        const cmd = String(input.command || '');
        if (cmd.includes('resolve-story.sh')) setPhase(run, 0, 'resolve-story.sh');
        else if (pr.touches) setPhase(run, PHASE_PR, pr.creates ? 'abriendo PR' : 'verificando PR');
        continue;
      }
      if (pr.touches) {
        setPhase(run, PHASE_PR, pr.creates ? 'abriendo PR por MCP' : 'verificando PR por MCP');
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
        if (!esEvidencia && run.phase !== null && run.phase < PHASE_IMPL) {
          setPhase(run, PHASE_IMPL, 'implementando');
        }
      }
    }

    // Los agentes devuelven JSON con `verdict`. Un bloqueo detiene el run.
    if (b.type === 'tool_result' || b.type === 'text') {
      const text = blockText(b);

      // El resultado se le cuelga al nodo que hizo la llamada: es lo que se ve
      // al clickear ese componente en el grafo.
      if (b.type === 'tool_result' && b.tool_use_id) {
        const pending = run.pending.get(b.tool_use_id);
        if (pending) {
          run.pending.delete(b.tool_use_id);
          emit(run, {
            t: 'output', node: pending.node, agent: pending.agent, name: pending.name,
            id: b.tool_use_id,
            text: text.slice(0, 6000), at: Date.now(),
          });

          if (pending.touchesPr && !b.is_error) run.prConfirmed = true;

          const answer = pending.agent ? agentJson(text) : null;
          if (answer?.verdict === 'BLOCKED') {
            queueBlock(run, {
              phase: pending.phase ?? 1,
              agent: pending.agent,
              reason: BLOCK_REASON[pending.agent] || 'El ciclo necesita una decisión humana',
              questions: Array.isArray(answer.blocking_questions) ? answer.blocking_questions : [],
              sourceId: b.tool_use_id,
            });
          } else if (pending.agent === 'arquitectura' && /blast_radius\s*:?\s*"?high/i.test(text)) {
            queueBlock(run, {
              phase: pending.phase ?? 2,
              agent: pending.agent,
              reason: 'El cambio tiene blast radius alto y requiere revisión humana',
              questions: ['¿Aprobás continuar con el alcance y los riesgos propuestos por arquitectura?'],
              sourceId: b.tool_use_id,
            });
          }
        }
      }
    }
  }
}

function setPhase(run, phase, detail) {
  // Un run bloqueado no avanza más. El corte es terminal por diseño (D2), y
  // mostrar la vía progresando después de un bloqueo comunica exactamente lo
  // contrario de lo que hizo el circuit breaker.
  if (run.blocked || run.pendingBlock) return false;
  if (run.phase === phase) return true;
  run.phase = phase;
  run.phaseHistory.push({ phase, detail, at: Date.now() });
  emit(run, { t: 'phase', phase, detail, at: Date.now() });
  return true;
}

/** Confirma el avance leyendo los artefactos que el flujo deja en disco. */
async function pollArtifacts(run) {
  if (!run.storyId) return; // sesión de consola: no hay run de historia que auditar
  const dir = path.join(TARGET_REPO, '.claude/run', run.storyId);
  const map = [
    ['story.json', 0], ['config.json', 0], ['git.json', 0],
    ['refinement.json', 1], ['architecture.json', 2], ['plan.md', 2],
    ['design.json', 3], ['design.md', 3], ['implementation.json', 4],
    ['qa.json', 5], ['security.json', 5], ['review.json', 6],
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
function beginRunWork(run, at = Date.now()) {
  if (run.activeStartedAt == null) run.activeStartedAt = at;
  run.status = 'running';
}

function pauseRunWork(run, at = Date.now()) {
  if (run.activeStartedAt == null) return;
  run.elapsedMs += Math.max(0, at - run.activeStartedAt);
  run.activeStartedAt = null;
}

const runElapsed = (run, at = Date.now()) => run.elapsedMs + (
  run.activeStartedAt == null ? 0 : Math.max(0, at - run.activeStartedAt)
);

function sendToRun(run, text, { event = 'ask', displayText = text } = {}) {
  if (!run.child || run.stdinClosed) {
    throw Object.assign(new Error('la sesión ya está cerrada'), { code: 409 });
  }
  run.child.stdin.write(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n');
  beginRunWork(run);
  emit(run, { t: event, text: String(displayText).slice(0, 2000), at: Date.now() });
}

/**
 * Un `result` cierra un turno y deja la sesión esperando, pero el proceso puede
 * volver a emitir mensajes (por ejemplo al continuar después de recuperar el
 * run). La actividad del stream es la señal más confiable de que Claude está
 * trabajando: cuando aparece, servidor y UI vuelven juntos a `running`.
 */
function markRunActive(run) {
  if (run.blocked || run.cycleComplete) return;
  if (run.status === 'running' && run.activeStartedAt != null) return;
  beginRunWork(run);
  emit(run, { t: 'activity', phase: run.phase, at: Date.now() });
}

function startRun({ storyId, repoDir, manual, baseBranch, permissionMode, allowedTools, extraFlags }) {
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
  // Autorización quirúrgica: con `-p` no hay dónde aceptar un permiso, así que
  // lo que el run vaya a necesitar tiene que estar habilitado de antemano.
  if (allowedTools) args.push('--allowedTools', allowedTools);
  if (extraFlags) args.push(...extraFlags.split(/\s+/).filter(Boolean));

  const startedAt = Date.now();
  const run = {
    id, storyId, prompt, args, cwd: repoDir,
    startedAt, status: 'running', elapsedMs: 0,
    activeStartedAt: prompt ? startedAt : null,
    phase: null, phaseHistory: [], blocked: null, pendingBlock: null, cycleComplete: false,
    cost: 0, costReports: 0,
    artifacts: {}, events: [], clients: new Set(), child: null, stdinClosed: false,
    pending: new Map(), // tool_use_id -> herramienta/agente/nodo, para atribuir resultados
    actions: new Map(), autoRecoveryCount: 0, prConfirmed: false,
  };
  runs.set(id, run);

  let child;
  try {
    // `resolve-story.sh` ya lee esta variable para dejarla en run.json, así que
    // elegir la branch base en el panel alcanza para que el ciclo la respete.
    const env = { ...process.env };
    if (baseBranch) env.CLAUDE_PLUGIN_OPTION_BASE_BRANCH = baseBranch;
    child = spawn('claude', args, { cwd: repoDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    pauseRunWork(run);
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
    pauseRunWork(run);
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
        markRunActive(run);
        inferPhase(run, msg);
        const text = (msg.message?.content || [])
          .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        if (text) {
          emit(run, {
            t: 'say', node: `phase:${run.phase ?? 0}`,
            text: text.slice(0, 4000), at: Date.now(),
          });
        }
      } else if (msg.type === 'user') {
        // En el stream de Claude, los resultados de herramientas llegan como
        // mensajes `user`: también prueban que el turno sigue ejecutándose.
        markRunActive(run);
        inferPhase(run, msg);
      } else if (msg.type === 'result') {
        // Claude informa el costo de cada turno terminado. El Studio mantiene
        // el acumulado de toda la sesión para que continuar el chat no vuelva
        // a mostrar solamente el último importe.
        const turnCost = Number(msg.total_cost_usd);
        if (Number.isFinite(turnCost) && turnCost >= 0) {
          run.cost += turnCost;
          run.costReports++;
        }
        run.turns = msg.num_turns ?? null;
        // Terminó el turno, no la sesión: el reloj se pausa mientras queda
        // esperando el próximo mensaje.
        pauseRunWork(run);
        run.status = run.stdinClosed ? 'done' : 'idle';
        const resultText = typeof msg.result === 'string' ? msg.result.trim() : '';
        const interrupted = technicalToolInterruption(resultText);
        if (!msg.is_error && finalCycleCompletion(resultText, run.prConfirmed)) {
          completeCycle(run, 'PR listo para revisión');
        }
        if (!interrupted) run.autoRecoveryCount = 0;
        if (!msg.is_error && !interrupted && !run.pendingBlock && !run.blocked && !run.cycleComplete) {
          const request = humanInputRequest(resultText);
          if (request) queueBlock(run, {
            phase: run.phase ?? 0,
            agent: null,
            reason: request.reason,
            questions: request.questions,
          });
        }
        if (run.pendingBlock) {
          const pendingBlock = run.pendingBlock;
          run.pendingBlock = null;
          blockRun(run, pendingBlock);
        }
        emit(run, {
          t: 'result',
          ok: !msg.is_error,
          status: run.status,
          cost: run.cost,
          costReported: Number.isFinite(turnCost) && turnCost >= 0,
          costReports: run.costReports,
          elapsedMs: run.elapsedMs,
          turnCost: Number.isFinite(turnCost) ? turnCost : null,
          turns: run.turns,
          text: resultText ? resultText.slice(0, 4000) : null,
          recovering: interrupted && run.autoRecoveryCount < 3,
          at: Date.now(),
        });
        if (interrupted && !run.blocked && !run.cycleComplete && !run.stdinClosed) {
          if (run.autoRecoveryCount < 3) {
            run.autoRecoveryCount++;
            // El tool_use anterior no va a recibir tool_result después de un
            // `result`; olvidarlo evita que quede como trabajo fantasma.
            run.pending.clear();
            sendToRun(run,
              RECOVERY_PROMPT,
              {
                event: 'recovery',
                displayText: `Interrupción técnica detectada · reintentando automáticamente (${run.autoRecoveryCount}/3)`,
              },
            );
          } else {
            blockRun(run, {
              phase: run.phase ?? 0,
              agent: null,
              reason: 'Claude Code interrumpió tres veces seguidas una herramienta y no pudo recuperarse solo',
              questions: ['Revisá el detalle técnico y reiniciá la ejecución.'],
            });
          }
        }
      }
    }
    await pollArtifacts(run);
  });

  child.stderr.on('data', (chunk) => {
    emit(run, { t: 'stderr', text: chunk.toString('utf8').slice(0, 800), at: Date.now() });
  });

  child.on('close', (code) => {
    pauseRunWork(run);
    if (run.status !== 'stopped') run.status = code === 0 ? 'done' : 'error';
    emit(run, { t: 'end', code, status: run.status, elapsedMs: run.elapsedMs, at: Date.now() });
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

    // --- repositorio y credenciales de VCS ---
    if (p === '/api/repo' && req.method === 'GET') {
      const info = parseRepoUrl(url.searchParams.get('url') || '');
      const vcs = info.ok ? await vcsStatus(info.provider) : null;
      return json(res, 200, { info, vcs, workspace: WORKSPACE });
    }

    if (p === '/api/repo/prepare' && req.method === 'POST') {
      const { url: repoUrl } = JSON.parse(await readBody(req));
      const out = await prepararRepo(repoUrl);
      return json(res, 200, out);
    }

    if (p === '/api/vcs/login' && req.method === 'POST') {
      const { provider } = JSON.parse(await readBody(req));
      const { error } = startVcsLogin(provider);
      return json(res, error ? 409 : 200, error ? { error } : { ok: true });
    }

    if (p === '/api/vcs/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const ev of vcsLogin.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (vcsLogin.child) {
        vcsLogin.clients.add(res);
        req.on('close', () => vcsLogin.clients.delete(res));
      } else {
        res.end();
      }
      return;
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

    if (p === '/api/config' && req.method === 'GET') {
      const repoDir = path.resolve(url.searchParams.get('repoDir') || TARGET_REPO);
      if (!fs.existsSync(repoDir)) {
        return json(res, 400, { error: `El directorio no existe: ${repoDir}` });
      }
      return json(res, 200, await readProjectConfig(repoDir));
    }

    if (p === '/api/config' && req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      const repoDir = path.resolve(body.repoDir || TARGET_REPO);
      if (!fs.existsSync(repoDir)) {
        return json(res, 400, { error: `El directorio no existe: ${repoDir}` });
      }
      const file = await writeProjectConfig(repoDir, body);
      // Se devuelve lo efectivo, no lo que mandó el cliente: es lo que va a leer
      // el ciclo, y si un default pisó algo tiene que verse en el acto.
      return json(res, 200, { path: file, ...(await readProjectConfig(repoDir)) });
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
        baseBranch: String(body.baseBranch || '').trim(),
        permissionMode: body.permissionMode || null,
        allowedTools: String(body.allowedTools || '').trim(),
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

    // Resumen de un run. Lo usa el front al recargar la página para saber si el
    // run que tenía guardado sigue existiendo antes de reengancharse al stream.
    let m = p.match(/^\/api\/run\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'run no encontrado' });
      return json(res, 200, {
        id: run.id, storyId: run.storyId, status: run.status, phase: run.phase,
        blocked: run.blocked, cost: run.cost ?? null, costReports: run.costReports ?? 0,
        elapsedMs: runElapsed(run),
        turns: run.turns ?? null,
        actions: [...run.actions.values()], cycleComplete: run.cycleComplete,
        cwd: run.cwd, prompt: run.prompt, vivo: !!run.child,
      });
    }

    m = p.match(/^\/api\/run\/([\w-]+)\/stream$/);
    if (m && req.method === 'GET') {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'run no encontrado' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      // Marca el fin del replay para que el front no abra diálogos una vez por
      // cada evento histórico; el estado ya quedó reconstruido en ese punto.
      res.write(`data: ${JSON.stringify({
        t: 'snapshot', status: run.status, elapsedMs: runElapsed(run), at: Date.now(),
      })}\n\n`);
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

    m = p.match(/^\/api\/run\/([\w-]+)\/action$/);
    if (m && req.method === 'POST') {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'run no encontrado' });
      const { actionId, text } = JSON.parse(await readBody(req));
      const action = run.actions.get(String(actionId || ''));
      if (!action || action.status !== 'open') {
        return json(res, 409, { error: 'la acción ya no está pendiente' });
      }
      if (!String(text || '').trim()) return json(res, 400, { error: 'escribí una respuesta' });
      if (!run.child || run.stdinClosed) {
        return json(res, 409, { error: 'la sesión ya está cerrada; iniciá un nuevo ciclo con esta decisión en la historia' });
      }

      action.status = 'resolved';
      action.resolvedAt = Date.now();
      run.blocked = null;
      emit(run, { t: 'action_resolved', id: action.id, phase: action.phase, at: action.resolvedAt });
      sendToRun(run,
        `Respuesta humana para resolver el bloqueo de ${action.agent ? `@${action.agent}` : `la fase ${action.phase}`}\n\n` +
        `${String(text).trim()}\n\nRetomá el ciclo desde esa fase usando esta decisión.`,
      );
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
      pauseRunWork(run);
      run.status = 'stopped';
      emit(run, { t: 'end', code: null, status: 'stopped', elapsedMs: run.elapsedMs, at: Date.now() });
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
