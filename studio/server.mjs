#!/usr/bin/env node
/**
 * sdlc studio — servidor local.
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
  MAX_CORRECTION_ROUNDS,
  RECOVERY_PROMPT,
  EMPTY_TOKEN_USAGE,
  addTokenUsage,
  auditCorrection,
  correctionRoundForTransition,
  correctionSourceForTransition,
  finalCycleCompletion,
  humanInputRequest,
  prCommand,
  prTool,
  technicalToolInterruption,
  usagePlan,
} from './run-signals.mjs';
import {
  discoverWorkspaces,
  discoverProjectProfile,
  isolatedWorktreePath,
  repoHintVerdict,
  repoNames,
  safeScope,
} from './repository.mjs';
import { hookEventsSince } from './hook-events.mjs';
import { toolActivity } from './tool-activity.mjs';
import { mcpLoginCommand, parseMcpStatus, pluginMcpName } from './mcp-auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

// ---------------------------------------------------------------- argumentos

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PLUGIN_DIR = path.resolve(arg('plugin', path.join(REPO_ROOT, 'plugins/sdlc')));
const TARGET_REPO_INPUT = arg('repo', process.env.SDLC_TARGET_REPO || '');
const TARGET_REPO_EXPLICIT = !!TARGET_REPO_INPUT;
const TARGET_REPO = path.resolve(TARGET_REPO_INPUT || process.cwd());
const PORT = Number(arg('port', 4477));
const PUBLIC_DIR = path.join(HERE, 'public');
// Dónde se clonan los repos que se piden por URL. Fuera del repo del plugin a
// propósito: son repos de trabajo, no parte de este proyecto.
const WORKSPACE = path.resolve(
  arg('workspace', process.env.SDLC_WORKSPACE || path.join(os.homedir(), 'sdlc-repos')),
);

// Extensiones editables. Todo lo demás es de solo lectura desde el studio.
const EDITABLE = new Set(['.md', '.json', '.sh', '.yml', '.yaml']);

/**
 * Nombre del plugin, leído del manifest.
 *
 * Hace falta porque las skills y los subagentes de un plugin se invocan
 * calificados con él: `/sdlc:us`, no `/us`. Sin el prefijo, Claude
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

/** `us` → `sdlc:us`. Sin manifest legible cae al nombre suelto. */
const qualify = name => (PLUGIN_NAME ? `${PLUGIN_NAME}:${name}` : name);

/** `sdlc:refinamiento` → `refinamiento`, para mapear contra AGENT_PHASE. */
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

/**
 * Los checkpoints viven en el prompt del agente para que Studio no mantenga
 * una segunda lista que pueda desincronizarse. Solo se acepta una lista
 * numerada simple bajo `## Progreso observable`.
 */
function agentProgressSteps(body) {
  const section = String(body || '').match(
    /^## Progreso observable\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m,
  )?.[1] || '';
  return [...section.matchAll(/^\s*\d+\.\s+(.+)$/gm)]
    .map(([, label]) => label.replace(/`/g, '').trim())
    .filter(Boolean);
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
    targetRepoExplicit: TARGET_REPO_EXPLICIT,
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
        progressSteps: agentProgressSteps(fm.body),
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

// ------------------------------------------------- importación de otro repo
//
// "Importar LLM": se pega el link de un repo y el studio arma el mapa con todo
// lo que Claude Code cargaría ahí — memoria, skills, comandos, subagentes,
// hooks, MCP servers y plugins propios del repo. El escaneo es de solo
// lectura y genérico: no asume el ciclo del skill `us` ni ningún layout más
// allá de las convenciones de Claude Code (.claude/, .claude-plugin/, .mcp.json).

/**
 * Directorios ya importados en esta sesión del studio. El endpoint de lectura
 * de archivos importados solo sirve lo que está acá adentro: sin esto sería un
 * lector de disco arbitrario con un parámetro `dir`.
 */
const importedDirs = new Set();

// Jobs de importación en curso o recién terminados, para el SSE de progreso.
const importJobs = new Map();
let importSeq = 0;

const readIf = async f => { try { return await fsp.readFile(f, 'utf8'); } catch { return null; } };

async function scanSkillsInto(skillsDir, source, rel, out) {
  let names = [];
  try {
    names = (await fsp.readdir(skillsDir, { withFileTypes: true }))
      .filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch { return; }
  for (const name of names) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    const text = await readIf(file);
    if (text === null) continue;
    const fm = parseFrontmatter(text);
    out.skills.push({
      kind: 'skill', name: fm.data?.name || name, path: rel(file),
      description: fm.data?.description || '', source,
    });
  }
}

async function scanAgentsInto(agentsDir, source, rel, out) {
  for (const f of await listDir(agentsDir, n => n.endsWith('.md'))) {
    const file = path.join(agentsDir, f);
    const text = await readIf(file);
    if (text === null) continue;
    const d = parseFrontmatter(text).data || {};
    const denied = Array.isArray(d.disallowedTools)
      ? d.disallowedTools
      : String(d.disallowedTools || '').split(',').map(s => s.trim()).filter(Boolean);
    out.agents.push({
      kind: 'agent', name: d.name || f.replace(/\.md$/, ''), path: rel(file),
      description: d.description || '', model: d.model || '(heredado)',
      readOnly: denied.includes('Write') && denied.includes('Edit'), source,
    });
  }
}

/** Los comandos se namespacian por subcarpeta: `commands/db/reset.md` → `db:reset`. */
async function scanCommandsInto(cmdDir, source, rel, out, prefix = '') {
  let entries = [];
  try { entries = await fsp.readdir(cmdDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isDirectory()) {
      await scanCommandsInto(path.join(cmdDir, e.name), source, rel, out, `${prefix}${e.name}:`);
      continue;
    }
    if (!e.name.endsWith('.md')) continue;
    const file = path.join(cmdDir, e.name);
    const fm = parseFrontmatter((await readIf(file)) || '');
    out.commands.push({
      kind: 'command', name: prefix + e.name.replace(/\.md$/, ''), path: rel(file),
      description: fm.data?.description || '', source,
    });
  }
}

/** El mismo esquema `{"hooks": {...}}` sirve para hooks.json de un plugin y para settings.json. */
function collectHooksInto(data, relPath, source, out) {
  for (const [event, entries] of Object.entries(data.hooks || {})) {
    for (const entry of entries || []) {
      for (const h of entry.hooks || []) {
        const scriptName = (String(h.command || '').match(/([A-Za-z0-9._-]+\.sh)/) || [])[1] || null;
        out.hooks.push({
          kind: 'hook', event, matcher: entry.matcher || '*',
          description: h.description || '', script: scriptName, path: relPath, source,
        });
      }
    }
  }
}

function collectMcpInto(data, relPath, source, out) {
  for (const [name, cfg] of Object.entries(data.mcpServers || {})) {
    out.mcp.push({
      kind: 'mcp', name,
      transport: cfg.type || (cfg.command ? 'stdio' : 'desconocido'),
      target: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '),
      path: relPath, source,
    });
  }
}

/**
 * Escanea un repo cualquiera buscando lo que Claude Code cargaría ahí.
 *
 * Cubre las dos formas en que un repo aporta componentes: la configuración de
 * proyecto (`CLAUDE.md`, `.claude/`, `.mcp.json`) y los plugins que el repo
 * trae consigo (`.claude-plugin/` en el root o bajo `plugins/`). Cada
 * componente lleva `source` para distinguir de dónde salió.
 */
async function scanClaudeRepo(rootDir, onStep = null) {
  const rel = p => path.relative(rootDir, p).split(path.sep).join('/');
  const out = {
    dir: rootDir, memory: [], skills: [], commands: [], agents: [],
    hooks: [], mcp: [], plugins: [], problems: [],
  };

  // memoria: CLAUDE.md y las reglas que importa
  onStep?.(0, 'Leyendo la memoria del repo');
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md']) {
    const text = await readIf(path.join(rootDir, f));
    if (text !== null) {
      out.memory.push({ kind: 'memory', name: f, path: f, bytes: Buffer.byteLength(text), source: 'proyecto' });
    }
  }
  const rulesDir = path.join(rootDir, '.claude/rules');
  for (const f of await listDir(rulesDir, n => n.endsWith('.md'))) {
    out.memory.push({ kind: 'memory', name: `rules/${f}`, path: rel(path.join(rulesDir, f)), source: 'proyecto' });
  }

  // configuración de proyecto
  onStep?.(25, 'Buscando skills, comandos y subagentes');
  const dot = path.join(rootDir, '.claude');
  await scanSkillsInto(path.join(dot, 'skills'), 'proyecto', rel, out);
  await scanAgentsInto(path.join(dot, 'agents'), 'proyecto', rel, out);
  await scanCommandsInto(path.join(dot, 'commands'), 'proyecto', rel, out);
  try {
    collectHooksInto(
      JSON.parse(await fsp.readFile(path.join(dot, 'settings.json'), 'utf8')),
      '.claude/settings.json', 'proyecto', out,
    );
  } catch { /* sin settings o sin hooks */ }
  try {
    collectMcpInto(
      JSON.parse(await fsp.readFile(path.join(rootDir, '.mcp.json'), 'utf8')),
      '.mcp.json', 'proyecto', out,
    );
  } catch { /* opcional */ }

  // plugins del repo: en el root o bajo plugins/
  const pluginDirs = [];
  if (fs.existsSync(path.join(rootDir, '.claude-plugin/plugin.json'))) pluginDirs.push(rootDir);
  const plugRoot = path.join(rootDir, 'plugins');
  try {
    for (const d of (await fsp.readdir(plugRoot, { withFileTypes: true })).filter(x => x.isDirectory())) {
      if (fs.existsSync(path.join(plugRoot, d.name, '.claude-plugin/plugin.json'))) {
        pluginDirs.push(path.join(plugRoot, d.name));
      }
    }
  } catch { /* sin plugins/ */ }

  let plugN = 0;
  for (const pdir of pluginDirs) {
    let name = path.basename(pdir);
    onStep?.(55 + (45 * plugN++ / pluginDirs.length), `Escaneando el plugin ${path.basename(pdir)}`);
    try {
      name = JSON.parse(await fsp.readFile(path.join(pdir, '.claude-plugin/plugin.json'), 'utf8')).name || name;
    } catch (e) {
      out.problems.push(`${rel(path.join(pdir, '.claude-plugin/plugin.json'))}: ${e.message}`);
    }
    out.plugins.push({ kind: 'plugin', name, path: rel(path.join(pdir, '.claude-plugin/plugin.json')) });
    await scanSkillsInto(path.join(pdir, 'skills'), name, rel, out);
    await scanAgentsInto(path.join(pdir, 'agents'), name, rel, out);
    await scanCommandsInto(path.join(pdir, 'commands'), name, rel, out);
    try {
      collectHooksInto(
        JSON.parse(await fsp.readFile(path.join(pdir, 'hooks/hooks.json'), 'utf8')),
        rel(path.join(pdir, 'hooks/hooks.json')), name, out,
      );
    } catch { /* sin hooks */ }
    try {
      collectMcpInto(
        JSON.parse(await fsp.readFile(path.join(pdir, '.mcp.json'), 'utf8')),
        rel(path.join(pdir, '.mcp.json')), name, out,
      );
    } catch { /* opcional */ }
  }

  const total = out.memory.length + out.skills.length + out.commands.length
    + out.agents.length + out.hooks.length + out.mcp.length;
  if (!total) {
    out.problems.push('El repo no tiene componentes de Claude Code: ni CLAUDE.md, ni .claude/, ni plugins.');
  }
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
 * Escribe `.claude/sdlc.json` en el repo objetivo.
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
  const file = path.join(dir, 'sdlc.json');
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

async function readJsonFile(file, fallback = {}) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return fallback; }
}

/**
 * Conserva cada PDF producido por el Studio en el repo asociado. El run puede
 * estar ejecutándose en un worktree aislado y desaparecer del mapa en memoria;
 * este archivo es el historial durable que usa la sección Informes.
 */
async function archiveRunReport(run, sourceFile, sourceStat) {
  const targetRunDir = runDirFor(run.sourceScope || run.sourceRepo || run.cwd, run.storyId);
  const reportsDir = path.join(targetRunDir, 'reports');
  const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-');
  const reportFile = path.join(reportsDir, `${stamp}.pdf`);
  const metadataFile = path.join(reportsDir, `${stamp}.json`);
  await fsp.mkdir(reportsDir, { recursive: true });
  if (path.resolve(sourceFile) !== path.resolve(reportFile)) await fsp.copyFile(sourceFile, reportFile);
  const story = await readJsonFile(path.join(path.dirname(sourceFile), 'story.json'));
  await fsp.writeFile(metadataFile, `${JSON.stringify({
    storyId: run.storyId.replace(/^#/, ''),
    title: story.title || '',
    tracker: story.tracker || '',
    runId: run.id,
    startedAt: new Date(run.startedAt).toISOString(),
    generatedAt: new Date(sourceStat.mtimeMs).toISOString(),
    sourceMtimeMs: sourceStat.mtimeMs,
  }, null, 2)}\n`, 'utf8');
}

async function listRunReports(repoDir) {
  const base = path.join(path.resolve(repoDir), '.claude', 'run');
  let dirs = [];
  try {
    dirs = (await fsp.readdir(base, { withFileTypes: true })).filter(entry => entry.isDirectory());
  } catch { return []; }

  const reports = [];
  for (const entry of dirs) {
    if (!STORY_ID_RE.test(entry.name)) continue;
    const runDir = runDirFor(repoDir, entry.name);
    const story = await readJsonFile(path.join(runDir, 'story.json'));
    const archiveDir = path.join(runDir, 'reports');
    let archived = [];
    try {
      archived = (await fsp.readdir(archiveDir, { withFileTypes: true }))
        .filter(file => file.isFile() && /^[A-Za-z0-9_.-]+\.pdf$/.test(file.name));
    } catch { /* todavía no hay archivo histórico */ }

    const archivedSourceTimes = [];
    for (const file of archived) {
      const pdf = path.join(archiveDir, file.name);
      const stat = await fsp.stat(pdf);
      const metadata = await readJsonFile(path.join(archiveDir, file.name.replace(/\.pdf$/, '.json')));
      if (Number.isFinite(metadata.sourceMtimeMs)) archivedSourceTimes.push(metadata.sourceMtimeMs);
      reports.push({
        storyId: entry.name,
        title: metadata.title || story.title || '',
        tracker: metadata.tracker || story.tracker || '',
        generatedAt: metadata.generatedAt || stat.mtime.toISOString(),
        size: stat.size,
        file: file.name,
      });
    }

    const current = path.join(runDir, 'report.pdf');
    const stat = await fsp.stat(current).catch(() => null);
    const alreadyArchived = stat && archivedSourceTimes.some(time => Math.abs(time - stat.mtimeMs) < 1);
    if (stat && !alreadyArchived) {
      reports.push({
        storyId: entry.name,
        title: story.title || '',
        tracker: story.tracker || '',
        generatedAt: stat.mtime.toISOString(),
        size: stat.size,
        file: 'report.pdf',
      });
    }
  }
  return reports.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
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
function manualStory(input) {
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
  return {
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
    repo_hint: String(input.repoHint || '').trim() || null,
    raw: { source: 'studio', authored_at: new Date().toISOString() },
  };
}

async function writeManualStory(repoDir, input) {
  const story = manualStory(input);
  const { id } = story;

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
    const { timeoutMs = 0, onStderr = null, ...spawnOpts } = opts;
    let stdout = '', stderr = '';
    let settled = false, timedOut = false, timer = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const c = spawn(bin, args, { cwd: REPO_ROOT, ...spawnOpts });
    c.stdout.on('data', d => stdout += d);
    c.stderr.on('data', d => { stderr += d; onStderr?.(String(d)); });
    c.on('error', () => finish({ code: -1, stdout: '', stderr: `no se encontró ${bin}` }));
    c.on('close', code => finish({
      code: timedOut ? 124 : code,
      stdout,
      stderr: timedOut ? `${stderr}\nLa comprobación tardó demasiado.`.trim() : stderr,
    }));
    if (timeoutMs > 0) timer = setTimeout(() => {
      timedOut = true;
      c.kill('SIGTERM');
    }, timeoutMs);
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
 * Traduce las líneas de progreso de git (`--progress` en stderr) a un
 * porcentaje 0–100 de la etapa git completa. Los pesos reflejan dónde se va el
 * tiempo real de un clone: la descarga de objetos domina.
 */
function gitProgress(line) {
  let m;
  if ((m = line.match(/Receiving objects:\s+(\d+)%/))) return { pct: 20 + Number(m[1]) * 0.6, step: 'Descargando objetos' };
  if ((m = line.match(/Resolving deltas:\s+(\d+)%/))) return { pct: 80 + Number(m[1]) * 0.18, step: 'Resolviendo deltas' };
  if ((m = line.match(/Compressing objects:\s+(\d+)%/))) return { pct: 8 + Number(m[1]) * 0.12, step: 'Comprimiendo objetos' };
  if (/Counting objects|Enumerating objects/.test(line)) return { pct: 4, step: 'Contando objetos' };
  if (/Updating files:\s+(\d+)%/.test(line)) return { pct: 98, step: 'Escribiendo archivos' };
  return null;
}

/** Convierte un chunk de stderr de git en llamadas a onProgress. */
const gitProgressSink = onProgress => {
  // git reescribe la misma línea con \r: cada fragmento puede traer varias.
  let last = -1;
  return chunk => {
    for (const line of String(chunk).split(/[\r\n]+/)) {
      const p = gitProgress(line);
      // Nunca retroceder: los mensajes de git no llegan estrictamente ordenados.
      if (p && p.pct > last) { last = p.pct; onProgress?.(p.pct, p.step); }
    }
  };
};

/**
 * Deja el repo listo en disco y devuelve sus branches. Clona la primera vez y
 * hace fetch después: reclonar en cada run sería lento y perdería el trabajo.
 * `onProgress(pct, step)` es opcional y reporta el avance de la etapa git.
 */
async function prepararRepo(raw, onProgress = null) {
  // Una carpeta local existente puede ser el root o cualquier directorio de un
  // monorepo. Se actualiza igual que un clone administrado por Studio: mostrar
  // branches viejas en el preflight termina creando features desde una base
  // distinta de la que el usuario eligió.
  const comoPath = path.resolve(String(raw || '').trim());
  if (fs.existsSync(comoPath)) {
    const root = await runClaudeLike('git', ['rev-parse', '--show-toplevel'], { cwd: comoPath });
    if (root.code === 0) {
      const dir = root.stdout.trim();
      const remotes = await runClaudeLike('git', ['remote'], { cwd: dir });
      if (remotes.stdout.trim()) {
        onProgress?.(2, 'Actualizando el repositorio');
        const fetched = await runClaudeLike('git', ['fetch', '--all', '--prune', '--progress'],
          { cwd: dir, onStderr: gitProgressSink(onProgress) });
        if (fetched.code !== 0) {
          throw Object.assign(new Error(`git fetch falló: ${fetched.stderr.slice(0, 300)}`), { code: 502 });
        }
      }
      return { dir, clonado: false, local: true, ...(await ramas(dir)), workspaces: await discoverWorkspaces(dir) };
    }
  }

  const info = parseRepoUrl(raw);
  if (!info.ok) throw Object.assign(new Error(info.error), { code: 400 });

  const slug = [info.org, info.project, info.repo].filter(Boolean).join('__')
    .replace(/[^A-Za-z0-9._-]/g, '-');
  const dir = path.join(WORKSPACE, slug);

  if (fs.existsSync(path.join(dir, '.git'))) {
    onProgress?.(2, 'Actualizando el repositorio');
    const r = await runClaudeLike('git', ['fetch', '--all', '--prune', '--progress'],
      { cwd: dir, onStderr: gitProgressSink(onProgress) });
    if (r.code !== 0) throw Object.assign(new Error(`git fetch falló: ${r.stderr.slice(0, 300)}`), { code: 502 });
    return { dir, clonado: false, provider: info.provider, ...(await ramas(dir)), workspaces: await discoverWorkspaces(dir) };
  }

  await fsp.mkdir(WORKSPACE, { recursive: true });
  onProgress?.(2, 'Clonando el repositorio');
  const r = await runClaudeLike('git', ['clone', '--progress', info.url, dir],
    { cwd: WORKSPACE, onStderr: gitProgressSink(onProgress) });
  if (r.code !== 0) {
    throw Object.assign(
      new Error(`git clone falló. ${r.stderr.slice(0, 400)}`),
      { code: 502 },
    );
  }
  return { dir, clonado: true, provider: info.provider, ...(await ramas(dir)), workspaces: await discoverWorkspaces(dir) };
}

/**
 * Crea un proyecto vacío administrado por Studio. El commit inicial no agrega
 * archivos: existe solamente para que `main` sea una base válida desde la que
 * el ciclo pueda abrir su feature branch.
 */
async function crearProyecto(nombre) {
  const clean = String(nombre || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(clean)) {
    throw Object.assign(
      new Error('usá un nombre de hasta 64 caracteres: letras, números, punto, guion o guion bajo'),
      { code: 400 },
    );
  }

  const dir = path.join(WORKSPACE, clean);
  if (fs.existsSync(dir) && (await fsp.readdir(dir)).length) {
    throw Object.assign(new Error(`ya existe un proyecto llamado ${clean}`), { code: 409 });
  }

  await fsp.mkdir(dir, { recursive: true });
  const init = await runClaudeLike('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (init.code !== 0) {
    throw Object.assign(new Error(`git init falló: ${init.stderr.slice(0, 300)}`), { code: 500 });
  }
  const commit = await runClaudeLike('git', [
    '-c', 'user.name=SDLC Studio',
    '-c', 'user.email=studio@localhost',
    'commit', '--allow-empty', '-qm', 'Initialize project',
  ], { cwd: dir });
  if (commit.code !== 0) {
    throw Object.assign(new Error(`no se pudo crear el commit inicial: ${commit.stderr.slice(0, 300)}`), { code: 500 });
  }

  return {
    dir,
    created: true,
    local: true,
    ...(await ramas(dir)),
    workspaces: ['.'],
  };
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
  // En clones viejos origin/HEAD puede quedar apuntando a una branch temporal
  // aunque el repo ya haya vuelto a main. Una base estable conocida gana sobre
  // ese puntero local; el usuario conserva el selector para repos con otra
  // convención.
  const estable = ['main', 'master', 'develop'].find(b => branches.includes(b));
  const porDefecto = estable || (head.code === 0
    ? head.stdout.trim().replace(/^origin\//, '')
    : branches[0] || null);

  return { branches, porDefecto };
}

async function gitValue(dir, args) {
  const out = await runClaudeLike('git', args, { cwd: dir });
  return out.code === 0 ? out.stdout.trim() : '';
}

/** Estado verificable que se muestra antes de autorizar un run. */
async function repositoryPreflight({ repoDir, baseBranch, scope = '', storyId = '', title = '', repoHint = '' }) {
  const selected = path.resolve(repoDir || TARGET_REPO);
  const root = await gitValue(selected, ['rev-parse', '--show-toplevel']);
  if (!root) throw Object.assign(new Error(`${selected} no es un repositorio Git`), { code: 400 });
  const scopedDir = safeScope(root, scope);
  const base = String(baseBranch || '').trim();
  if (!base) throw Object.assign(new Error('elegí una branch base'), { code: 400 });
  if (!String(scope || '').trim()) {
    throw Object.assign(new Error('elegí el alcance del repositorio'), { code: 400 });
  }
  if (base.startsWith('feature/')) {
    throw Object.assign(new Error('una feature no puede ser la base del modo automático'), { code: 400 });
  }
  const remote = await gitValue(root, ['remote', 'get-url', 'origin']);
  if (remote) {
    const fetched = await runClaudeLike('git', ['fetch', '--quiet', 'origin', base], { cwd: root });
    if (fetched.code !== 0) {
      throw Object.assign(new Error(`no se pudo actualizar origin/${base}: ${fetched.stderr.slice(0, 300)}`), { code: 502 });
    }
  }
  const baseRef = remote ? `origin/${base}` : base;
  if (!await gitValue(root, ['rev-parse', '--verify', `${baseRef}^{commit}`])) {
    throw Object.assign(new Error(`la branch base no existe: ${baseRef}`), { code: 400 });
  }
  const dirtyRaw = await gitValue(root, ['status', '--porcelain', '--untracked-files=all']);
  const dirty = dirtyRaw.split('\n').filter(Boolean)
    .filter(line => !/^.. \.claude\/(run\/|sdlc\.json$)/.test(line));
  const current = await gitValue(root, ['branch', '--show-current']);
  const counts = (await gitValue(root, ['rev-list', '--left-right', '--count', `${baseRef}...HEAD`]))
    .split(/\s+/).map(Number);
  const names = repoNames(root, remote, scope === '.' ? '' : scope);
  const hint = repoHintVerdict(repoHint, names);
  const cleanId = String(storyId || (title ? `LOCAL-${slugify(title)}` : '')).replace(/^#/, '');
  const candidate = cleanId && title
    ? `feature/${cleanId}-${slugify(title, 48)}`
    : cleanId ? `feature/${cleanId}` : '';
  const branches = (await gitValue(root, ['branch', '-a', '--format=%(refname:short)'])).split('\n').filter(Boolean);
  const related = cleanId
    ? branches.filter(branch => branch.replace(/^(?:remotes\/)?origin\//, '').startsWith(`feature/${cleanId}`))
    : [];
  return {
    repoDir: root, scopedDir, scope, remote, names, baseBranch: base, baseRef,
    currentBranch: current || '(detached)', dirty, ahead: counts[1] || 0, behind: counts[0] || 0,
    hint, candidateBranch: candidate, existingBranches: [...new Set(related)],
    workspaces: await discoverWorkspaces(root), profile: await discoverProjectProfile(scopedDir),
  };
}

async function copyRunConfig(sourceScope, targetScope) {
  const source = path.join(sourceScope, '.claude', 'sdlc.json');
  if (!fs.existsSync(source)) return;
  const targetDir = path.join(targetScope, '.claude');
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.copyFile(source, path.join(targetDir, 'sdlc.json'));
}

/** Crea o reutiliza un checkout aislado estable para repo + historia. */
async function prepareRunWorkspace(preflight, storyId, isolate = true, branchStrategy = 'resume') {
  if (!isolate) return { cwd: preflight.scopedDir, isolated: false, worktree: null };
  const cleanId = String(storyId).replace(/^#/, '');
  const workspaceId = branchStrategy === 'new' ? `${cleanId}-new-${Date.now()}` : cleanId;
  const worktree = isolatedWorktreePath(WORKSPACE, preflight.repoDir, workspaceId, preflight.scope);
  const scope = preflight.scope === '.' ? '.' : preflight.scope;
  let reused = false;
  const existing = await gitValue(worktree, ['rev-parse', '--show-toplevel']);
  if (existing) {
    reused = true;
  } else {
    if (fs.existsSync(worktree)) {
      throw Object.assign(new Error(`el destino del worktree existe pero no es Git: ${worktree}`), { code: 409 });
    }
    await fsp.mkdir(path.dirname(worktree), { recursive: true });
    const added = await runClaudeLike('git', ['worktree', 'add', '--detach', worktree, preflight.baseRef], { cwd: preflight.repoDir });
    if (added.code !== 0) {
      throw Object.assign(new Error(`no se pudo crear el worktree: ${added.stderr.slice(0, 400)}`), { code: 502 });
    }
  }
  const targetScope = safeScope(worktree, scope);
  await copyRunConfig(preflight.repoDir, targetScope);
  return { cwd: targetScope, isolated: true, worktree, reused };
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
 * y espera el callback. El CLI abre y completa ese recorrido por sí mismo; el
 * Studio solo inicia el proceso y comprueba el resultado, sin exponer consola,
 * URLs de callback ni tokens.
 *
 * Es un proceso único: dos logins en paralelo compiten por las mismas credenciales.
 */
const login = { child: null, status: 'idle', events: [], clients: new Set() };

const OAUTH_MCP = new Set(['figma', 'jira']);
const MCP_LOGIN_TIMEOUT_MS = 5 * 60_000;
const mcpLogin = {
  child: null, server: null, status: 'idle', events: [], clients: new Set(), timeout: null,
};

const mcpServerName = server => pluginMcpName(PLUGIN_NAME, server);

async function mcpAuthStatus(server) {
  if (!OAUTH_MCP.has(server)) {
    throw Object.assign(new Error(`MCP no soportado para OAuth: ${server}`), { code: 400 });
  }
  const qualified = mcpServerName(server);
  const out = await runClaude([
    '--plugin-dir', PLUGIN_DIR, 'mcp', 'get', qualified,
  ], { timeoutMs: 12_000 });
  return { server, qualified, ...parseMcpStatus(out.stdout, out.stderr, out.code) };
}

function startMcpLogin(server) {
  if (!OAUTH_MCP.has(server)) return { error: `MCP no soportado para OAuth: ${server}` };
  if (mcpLogin.child) return { error: `ya hay un login de ${mcpLogin.server} en curso` };

  const qualified = mcpServerName(server);
  const args = ['--plugin-dir', PLUGIN_DIR, 'mcp', 'login', qualified];
  mcpLogin.events = [];
  mcpLogin.server = server;
  mcpLogin.status = 'running';
  push(mcpLogin, { t: 'start', server, at: Date.now() });

  const launch = mcpLoginCommand(args, {
    platform: process.platform,
    stdinIsTTY: !!process.stdin.isTTY,
  });
  const child = spawn(launch.command, launch.args, {
    cwd: REPO_ROOT,
    stdio: [launch.stdin, 'pipe', 'pipe'],
  });
  mcpLogin.child = child;
  mcpLogin.timeout = setTimeout(() => {
    if (mcpLogin.child !== child) return;
    mcpLogin.status = 'timeout';
    push(mcpLogin, { t: 'timeout', server, at: Date.now() });
    child.kill('SIGTERM');
  }, MCP_LOGIN_TIMEOUT_MS);
  mcpLogin.timeout.unref();
  const scan = (text) => {
    push(mcpLogin, { t: 'out', text: text.slice(0, 2000), at: Date.now() });
    for (const raw of text.match(/https?:\/\/[^\s'"<>]+/g) || []) {
      push(mcpLogin, { t: 'url', url: raw.replace(/[),.;]+$/, ''), at: Date.now() });
    }
  };
  child.stdout.on('data', d => scan(d.toString('utf8')));
  child.stderr.on('data', d => scan(d.toString('utf8')));
  child.on('error', e => {
    mcpLogin.status = 'error';
    push(mcpLogin, {
      t: 'error', server,
      message: e.code === 'ENOENT' ? 'No se encontró el binario `claude` en el PATH.' : e.message,
      at: Date.now(),
    });
  });
  child.on('close', async (code) => {
    clearTimeout(mcpLogin.timeout);
    mcpLogin.timeout = null;
    const timedOut = mcpLogin.status === 'timeout';
    mcpLogin.child = null;
    mcpLogin.status = code === 0 ? 'done' : 'error';
    let auth;
    try { auth = await mcpAuthStatus(server); }
    catch (e) { auth = { server, status: 'unavailable', detail: e.message }; }
    if (timedOut && auth.status !== 'connected') {
      auth = {
        server,
        status: 'auth_required',
        detail: 'La autorización venció después de 5 minutos. Volvé a intentarlo.',
      };
    }
    push(mcpLogin, { t: 'end', server, code, status: mcpLogin.status, auth, at: Date.now() });
    for (const res of mcpLogin.clients) res.end();
    mcpLogin.clients.clear();
  });
  return { ok: true, server };
}

async function authStatus() {
  const { code, stdout, stderr } = await runClaude(['auth', 'status', '--json']);
  try {
    const status = JSON.parse(stdout);
    return { ok: true, ...status, usagePlan: usagePlan(status, process.env) };
  } catch {
    const status = {
      ok: false,
      loggedIn: false,
      error: (stderr || stdout || `exit ${code}`).trim().slice(0, 400),
    };
    return { ...status, usagePlan: usagePlan(status, process.env) };
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
  const friendly = toolActivity(name, input);
  if (friendly.summary) return friendly.summary;
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
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.verdict) return parsed;
  } catch { /* puede venir acompañada de prosa */ }
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
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
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (parsed?.verdict) return parsed;
        } catch { /* sigue buscando otro objeto */ }
        break;
      }
    }
  }
  return null;
}

/** Marcadores emitidos por los subagentes y reenviados por Claude Code. */
function agentProgress(text) {
  const out = [];
  const pattern = /SDLC_PROGRESS\s+(\{[^\n]*\})/g;
  for (const match of String(text || '').matchAll(pattern)) {
    try {
      const value = JSON.parse(match[1]);
      const step = Number(value.step);
      const total = Number(value.total);
      if (!Number.isInteger(step) || !Number.isInteger(total) || step < 1 || total < step) continue;
      out.push({ step, total, label: String(value.label || '').slice(0, 160) });
    } catch { /* un marcador parcial no debe romper el stream */ }
  }
  return out;
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

  // `--forward-subagent-text` conserva el id de la llamada Task/Agent padre.
  // Eso permite atribuir checkpoints internos sin confundirlos con la sesión
  // orquestadora ni inventarlos a partir de la cantidad de tools usadas.
  const parentId = msg.parent_tool_use_id || msg.message?.parent_tool_use_id;
  const parent = parentId ? run.pending.get(parentId) : null;
  if (parent?.agent) {
    const text = blocks.map(blockText).join('\n');
    for (const progress of agentProgress(text)) {
      emit(run, {
        t: 'agent_progress', agent: parent.agent, phase: parent.phase,
        ...progress, at: Date.now(),
      });
    }
  }

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
      const activity = toolActivity(name, input);
      if (b.id) run.pending.set(b.id, {
        node, name, agent, isPr: pr.creates, touchesPr: pr.touches,
        phase: agent ? AGENT_PHASE[agent] : run.phase,
        success: activity.success,
      });
      emit(run, {
        t: 'tool', name, node, agent, id: b.id || null,
        summary: toolSummary(name, input).slice(0, 400),
        progress: activity.progress, at: Date.now(),
      });

      if (isSubagentTool(name)) {
        // Los subagentes de un plugin llegan calificados: `sdlc:qa`.
        const phase = AGENT_PHASE[agent];
        if (phase !== undefined) {
          const nextRound = correctionRoundForTransition(
            run.phase, run.correctionRound, agent,
          );
          if (!run.blocked && !run.pendingBlock && nextRound > run.correctionRound) {
            const source = correctionSourceForTransition(
              run.phase, agent, run.correctionSource,
            );
            run.correctionRound = nextRound;
            if (source) run.correctionCounts[source]++;
            run.correctionSource = null;
            emit(run, {
              t: 'correction_round', round: run.correctionRound,
              max: MAX_CORRECTION_ROUNDS, phase, source,
              counts: { ...run.correctionCounts }, at: Date.now(),
            });
          }
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
            text: text.slice(0, 6000), success: pending.success,
            isError: !!b.is_error, at: Date.now(),
          });

          if (pending.touchesPr && !b.is_error) run.prConfirmed = true;

          const answer = pending.agent ? agentJson(text) : null;
          const audit = auditCorrection(pending.agent, answer?.verdict);
          if (audit) {
            if (audit.requested) run.correctionSource = audit.source;
            else if (run.correctionSource === audit.source) run.correctionSource = null;
            emit(run, {
              t: 'audit_verdict', ...audit, agent: pending.agent,
              detail: audit.requested
                ? `@${pending.agent} pidió cambios · vuelve a Implementación`
                : '@reviewer aprobó el diff · avanza a Pull Request',
              at: Date.now(),
            });
          }
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
  const dir = path.join(run.cwd, '.claude/run', run.storyId.replace(/^#/, ''));
  const map = [
    ['story.json', 0], ['config.json', 0], ['git.json', 0],
    ['refinement.json', 1], ['architecture.json', 2], ['plan.md', 2],
    ['design.json', 3], ['design.md', 3], ['implementation.json', 4],
    ['qa.json', 5], ['security.json', 5], ['review.json', 6],
    ['report.pdf', 7],
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
      if (file === 'report.pdf') {
        try { await archiveRunReport(run, path.join(dir, file), st); }
        catch (error) {
          emit(run, { t: 'stderr', text: `No se pudo archivar el reporte: ${error.message}`, at: Date.now() });
        }
      }
      emit(run, { t: 'artifact', file, phase, at: Date.now() });
    } catch { /* todavía no existe */ }
  }

  try {
    const content = await fsp.readFile(path.join(dir, 'hook-events.jsonl'), 'utf8');
    const batch = hookEventsSince(content, run.hookEventCursor, run.startedAt, run.id);
    run.hookEventCursor = batch.cursor;
    for (const event of batch.events) emit(run, { t: 'hook', ...event });
  } catch { /* ningún hook se activó todavía */ }
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

function startRun({ storyId, repoDir, sourceRepo, sourceScope, manual, baseBranch, permissionMode, allowedTools, extraFlags, workspaceInfo, branchStrategy, accountUsagePlan }) {
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
    '--forward-subagent-text',
    '--verbose',
    // Sin esto la sesión corre en el repo objetivo sin el plugin cargado, y
    // `/sdlc:us` no existe. Además hace que corra lo que hay en disco,
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
    id, storyId, prompt, args, cwd: repoDir, sourceRepo, sourceScope, baseBranch, workspaceInfo,
    startedAt, status: 'running', elapsedMs: 0,
    activeStartedAt: prompt ? startedAt : null,
    phase: null, phaseHistory: [], blocked: null, pendingBlock: null, cycleComplete: false,
    cost: 0, costReports: 0, accountUsagePlan,
    tokenUsage: { ...EMPTY_TOKEN_USAGE }, seenMessageIds: new Set(), turnSawUsage: false,
    artifacts: {}, events: [], clients: new Set(), child: null, stdinClosed: false,
    pending: new Map(), // tool_use_id -> herramienta/agente/nodo, para atribuir resultados
    actions: new Map(), autoRecoveryCount: 0, prConfirmed: false,
    correctionRound: 0, correctionSource: null,
    correctionCounts: { verification: 0, reviewer: 0 }, hookEventCursor: 0,
  };
  runs.set(id, run);

  let child;
  try {
    // `resolve-story.sh` ya lee esta variable para dejarla en run.json, así que
    // elegir la branch base en el panel alcanza para que el ciclo la respete.
    const env = { ...process.env };
    env.SDLC_STUDIO_RUN_ID = id;
    if (baseBranch) env.CLAUDE_PLUGIN_OPTION_BASE_BRANCH = baseBranch;
    if (storyId) env.SDLC_STORY_ID = storyId.replace(/^#/, '');
    if (sourceRepo) env.SDLC_SOURCE_REPO = sourceRepo;
    if (workspaceInfo?.isolated) env.SDLC_ISOLATED_WORKTREE = '1';
    if (branchStrategy === 'new') env.SDLC_FORCE_NEW_BRANCH = '1';
    child = spawn('claude', args, { cwd: repoDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    pauseRunWork(run);
    run.status = 'error';
    emit(run, { t: 'error', message: `No se pudo ejecutar \`claude\`: ${e.message}`, at: Date.now() });
    return run;
  }
  run.child = child;
  child.stdin.on('error', () => { /* la sesión se cerró del otro lado */ });

  emit(run, {
    t: 'start', storyId, cwd: repoDir, cmd: `claude ${args.join(' ')}`,
    usagePlan: run.accountUsagePlan, at: Date.now(),
  });

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
        const messageId = msg.message?.id;
        if (messageId && !run.seenMessageIds.has(messageId)) {
          run.seenMessageIds.add(messageId);
          run.tokenUsage = addTokenUsage(run.tokenUsage, msg.message?.usage);
          run.turnSawUsage = true;
        }
        inferPhase(run, msg);
        const text = (msg.message?.content || [])
          .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        // El texto reenviado de un subagente se usa para sus checkpoints. Su
        // salida completa llegará además como tool_result; publicarlo acá la
        // duplicaría y la atribuiría erróneamente a la fase principal.
        const forwarded = msg.parent_tool_use_id || msg.message?.parent_tool_use_id;
        if (text && !forwarded) {
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
        // Versiones del CLI que no adjuntan usage a los mensajes lo dejan en
        // result. Es fallback por turno: nunca se suma junto con ambos.
        if (!run.turnSawUsage && msg.usage) {
          run.tokenUsage = addTokenUsage(run.tokenUsage, msg.usage);
        }
        run.turnSawUsage = false;
        // Claude informa una estimación local por consulta. Solo se conserva
        // para cuentas API por uso; suscripciones y proveedores muestran tokens.
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
          usagePlan: run.accountUsagePlan,
          tokenUsage: run.tokenUsage,
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
    run.child = null;
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
      const { url: repoUrl, mode = 'existing' } = JSON.parse(await readBody(req));
      const out = mode === 'new' ? await crearProyecto(repoUrl) : await prepararRepo(repoUrl);
      return json(res, 200, out);
    }

    if (p === '/api/repo/preflight' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const out = await repositoryPreflight(body);
      return json(res, 200, out);
    }

    // --- Importar LLM: escanear otro repo y redibujar el mapa con lo que hay ---
    // El clon puede tardar, así que la importación es un job: el POST lo abre y
    // devuelve un id, y el avance —con el % real que reporta git— sale por SSE.
    if (p === '/api/import' && req.method === 'POST') {
      const { url: repoUrl } = JSON.parse(await readBody(req));
      const id = `imp_${++importSeq}_${Math.random().toString(36).slice(2, 8)}`;
      const job = { events: [], clients: new Set(), done: false };
      importJobs.set(id, job);

      const emit = ev => {
        job.events.push(ev);
        for (const c of job.clients) c.write(`data: ${JSON.stringify(ev)}\n\n`);
        if (ev.t !== 'progress') {
          job.done = true;
          for (const c of job.clients) c.end();
          job.clients.clear();
          // El resultado queda un rato por si el SSE se conecta tarde.
          setTimeout(() => importJobs.delete(id), 5 * 60_000).unref?.();
        }
      };
      // Nunca retroceder ni llegar a 100 antes del final: la barra es una
      // promesa y una barra que vuelve para atrás es peor que no tenerla.
      let last = 0;
      const progress = (pct, step) => {
        const v = Math.max(last, Math.min(99, Math.round(pct)));
        if (v === last && job.events.length && job.events[job.events.length - 1].step === step) return;
        last = v;
        emit({ t: 'progress', pct: v, step });
      };

      (async () => {
        try {
          progress(1, 'Preparando el repositorio');
          // 0–80: git (domina el tiempo con un repo remoto) · 80–99: escaneo.
          const repo = await prepararRepo(repoUrl, (pct, step) => progress(1 + pct * 0.79, step));
          importedDirs.add(repo.dir);
          progress(80, 'Escaneando el repo');
          const scan = await scanClaudeRepo(repo.dir, (pct, step) => progress(80 + pct * 0.19, step));
          emit({ t: 'done', pct: 100, result: { repo, scan } });
        } catch (e) {
          emit({ t: 'error', error: e.message });
        }
      })();

      return json(res, 200, { importId: id });
    }

    if (p === '/api/import/events' && req.method === 'GET') {
      const job = importJobs.get(String(url.searchParams.get('id') || ''));
      if (!job) return json(res, 404, { error: 'importación desconocida o expirada' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const ev of job.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (job.done) return res.end();
      job.clients.add(res);
      req.on('close', () => job.clients.delete(res));
      return;
    }

    // Lectura de un archivo del repo importado. Solo lectura y solo dentro de
    // un directorio que pasó por /api/import: el studio escribe únicamente
    // dentro del plugin, y eso no cambia acá.
    if (p === '/api/import/file' && req.method === 'GET') {
      const dir = path.resolve(String(url.searchParams.get('dir') || ''));
      if (!importedDirs.has(dir)) {
        return json(res, 403, { error: 'ese directorio no fue importado en esta sesión del studio' });
      }
      const abs = path.resolve(dir, String(url.searchParams.get('path') || ''));
      if (!abs.startsWith(dir + path.sep)) {
        return json(res, 403, { error: 'ruta fuera del repo importado' });
      }
      const text = await fsp.readFile(abs, 'utf8');
      return json(res, 200, { path: url.searchParams.get('path'), content: text.slice(0, 200_000) });
    }

    // Interpretación con Claude. El escaneo determinístico lista componentes,
    // pero el orden en que un skill orquestador los usa está escrito en prosa
    // en su SKILL.md: eso solo lo puede leer un modelo. Como ejecuta el binario
    // `claude` y gasta tokens, este endpoint corre únicamente cuando el dev lo
    // aceptó explícitamente en la UI — nunca como parte del import.
    if (p === '/api/import/interpret' && req.method === 'POST') {
      const { dir: rawDir, skillPath } = JSON.parse(await readBody(req));
      const dir = path.resolve(String(rawDir || ''));
      if (!importedDirs.has(dir)) {
        return json(res, 403, { error: 'ese directorio no fue importado en esta sesión del studio' });
      }
      const abs = path.resolve(dir, String(skillPath || ''));
      if (!abs.startsWith(dir + path.sep)) {
        return json(res, 403, { error: 'ruta fuera del repo importado' });
      }
      const skillText = (await fsp.readFile(abs, 'utf8')).slice(0, 60_000);
      const scan = await scanClaudeRepo(dir);
      const prompt = [
        'Te paso el SKILL.md de un skill orquestador de Claude Code y los componentes disponibles en su repo.',
        'Devolvé SOLO un objeto JSON válido, sin markdown ni texto alrededor, con esta forma exacta:',
        '{"phases":[{"label":"...","gate":false,"help":"...","agents":["nombre"],"scripts":["archivo.sh"]}]}',
        'Reglas: las fases en el orden real del ciclo que describe el skill; máximo 10 fases;',
        '"agents" solo con nombres de la lista de subagentes; "scripts" solo con nombres de la lista de scripts;',
        '"gate" es true si esa fase puede abortar el run; "help" es una línea en español rioplatense de qué pasa ahí.',
        'No uses ninguna herramienta: todo lo que necesitás está en este mensaje.',
        `Subagentes disponibles: ${scan.agents.map(a => a.name).join(', ') || '(ninguno)'}`,
        `Scripts mencionables: ${[...new Set(scan.hooks.map(h => h.script).filter(Boolean))].join(', ') || '(ninguno)'}`,
        'SKILL.md:',
        '---',
        skillText,
      ].join('\n');

      const r = await runClaude(['-p', '--output-format', 'json', prompt]);
      let texto = r.stdout;
      try {
        const payload = JSON.parse(r.stdout);
        if (typeof payload.result === 'string') texto = payload.result;
      } catch { /* salida no JSON: se busca el objeto en el texto crudo */ }
      const m = String(texto).match(/\{[\s\S]*\}/);
      let phases = null;
      try { phases = m && JSON.parse(m[0]).phases; } catch { /* abajo se reporta */ }
      if (!Array.isArray(phases) || !phases.length) {
        return json(res, 502, {
          error: 'Claude no devolvió un ciclo interpretable',
          detail: String(r.stderr || texto).slice(0, 400),
        });
      }
      // Se sanea la forma: el front dibuja esto tal cual y no debería poder
      // romperse por una respuesta creativa del modelo.
      phases = phases.slice(0, 10).map(f => ({
        label: String(f.label || 'fase').slice(0, 40),
        gate: !!f.gate,
        help: String(f.help || '').slice(0, 200),
        agents: (Array.isArray(f.agents) ? f.agents : []).map(a => String(a).slice(0, 60)).slice(0, 6),
        scripts: (Array.isArray(f.scripts) ? f.scripts : []).map(s => String(s).slice(0, 60)).slice(0, 4),
      }));
      return json(res, 200, { phases });
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

    if (p === '/api/mcp/status' && req.method === 'GET') {
      const server = String(url.searchParams.get('server') || '');
      try { return json(res, 200, await mcpAuthStatus(server)); }
      catch (e) { return json(res, e.code || 500, { error: e.message }); }
    }

    if (p === '/api/mcp/login' && req.method === 'POST') {
      const { server } = JSON.parse(await readBody(req) || '{}');
      const out = startMcpLogin(String(server || ''));
      return json(res, out.error ? 409 : 200, out.error ? { error: out.error } : out);
    }

    if (p === '/api/mcp/cancel' && req.method === 'POST') {
      mcpLogin.child?.kill('SIGTERM');
      return json(res, 200, { ok: true });
    }

    if (p === '/api/mcp/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for (const ev of mcpLogin.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (mcpLogin.child) {
        mcpLogin.clients.add(res);
        req.on('close', () => mcpLogin.clients.delete(res));
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

    if (p === '/api/reports' && req.method === 'GET') {
      const repoDir = path.resolve(url.searchParams.get('repoDir') || TARGET_REPO);
      if (!fs.existsSync(repoDir)) return json(res, 400, { error: `El directorio no existe: ${repoDir}` });
      const scopedDir = safeScope(repoDir, url.searchParams.get('scope') || '.');
      return json(res, 200, { reports: await listRunReports(scopedDir) });
    }

    if (p === '/api/reports/download' && req.method === 'GET') {
      const repoDir = path.resolve(url.searchParams.get('repoDir') || TARGET_REPO);
      const scopedDir = safeScope(repoDir, url.searchParams.get('scope') || '.');
      const storyId = String(url.searchParams.get('storyId') || '');
      const file = String(url.searchParams.get('file') || '');
      if (!STORY_ID_RE.test(storyId) || !/^[A-Za-z0-9_.-]+\.pdf$/.test(file)) {
        return json(res, 400, { error: 'reporte inválido' });
      }
      const runDir = runDirFor(scopedDir, storyId);
      const report = file === 'report.pdf' ? path.join(runDir, file) : path.join(runDir, 'reports', file);
      const body = await fsp.readFile(report).catch(() => null);
      if (!body) return json(res, 404, { error: 'reporte no encontrado' });
      const filename = `${storyId.replace(/[^\w.-]+/g, '-')}-${file === 'report.pdf' ? 'sdlc-report' : file.replace(/\.pdf$/, '')}.pdf`;
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': body.length,
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (p === '/api/run' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const selectedRepo = path.resolve(body.repoDir || TARGET_REPO);
      if (!fs.existsSync(selectedRepo)) {
        return json(res, 400, { error: `El directorio no existe: ${selectedRepo}` });
      }

      // Sin historia es una sesión de consola: se abre vacía, sin invocar /us.
      const consoleMode = body.mode === 'console';

      // Con historia escrita a mano, se persiste antes de arrancar: el resolver
      // la encuentra en disco en la fase 0 y no consulta ningún tracker.
      let storyId = String(body.storyId || '').trim();
      const manual = !consoleMode && !!(body.story && typeof body.story === 'object');
      if (manual) {
        const story = manualStory({ ...body.story, id: body.story.id || storyId });
        storyId = story.id;
      }
      if (consoleMode) {
        storyId = null;
      } else if (!STORY_ID_RE.test(storyId)) {
        return json(res, 400, { error: 'ID de historia inválido' });
      }

      let repoDir = selectedRepo;
      let workspaceInfo = { cwd: selectedRepo, isolated: false, worktree: null };
      let preflight = null;
      if (!consoleMode) {
        preflight = await repositoryPreflight({
          repoDir: selectedRepo,
          baseBranch: String(body.baseBranch || '').trim(),
          scope: String(body.scope || '.'),
          storyId,
          title: manual ? body.story.title : '',
          repoHint: manual ? body.story.repoHint : '',
        });
        if (preflight.hint.status === 'mismatch') {
          return json(res, 409, { error: `La historia indica el repo '${preflight.hint.hints[0]}', pero seleccionaste ${preflight.names.join(', ')}.` });
        }
        if (preflight.hint.status === 'multi-repo') {
          return json(res, 409, { error: `La historia indica varios repos (${preflight.hint.hints.join(', ')}). Dividí el alcance por repositorio antes de ejecutar: un run produce una branch y un PR.` });
        }
        const isolate = body.isolate !== false;
        if (!isolate && preflight.dirty.length) {
          return json(res, 409, { error: `El working tree tiene ${preflight.dirty.length} cambio(s). Activá el worktree aislado o guardá esos cambios.` });
        }
        workspaceInfo = await prepareRunWorkspace(preflight, storyId, isolate, body.branchStrategy || 'resume');
        repoDir = workspaceInfo.cwd;

        if (manual) await writeManualStory(repoDir, { ...body.story, id: storyId });
        const contextDir = runDirFor(repoDir, storyId);
        await fsp.mkdir(contextDir, { recursive: true });
        await fsp.writeFile(path.join(contextDir, 'repo-context.json'), `${JSON.stringify({
          source_repo: preflight.repoDir,
          working_repo: workspaceInfo.worktree || preflight.repoDir,
          scope: preflight.scope,
          names: preflight.names,
          remote: preflight.remote || null,
          base_branch: preflight.baseBranch,
          isolated: workspaceInfo.isolated,
          reused: !!workspaceInfo.reused,
          profile: preflight.profile,
        }, null, 2)}\n`, 'utf8');
      }

      const account = await authStatus();
      const run = startRun({
        storyId,
        repoDir,
        sourceRepo: preflight?.repoDir || selectedRepo,
        sourceScope: preflight?.scopedDir || selectedRepo,
        manual,
        baseBranch: String(body.baseBranch || '').trim(),
        permissionMode: body.permissionMode || null,
        allowedTools: String(body.allowedTools || '').trim(),
        extraFlags: body.extraFlags || '',
        workspaceInfo,
        branchStrategy: body.branchStrategy || 'resume',
        accountUsagePlan: account.usagePlan,
      });
      return json(res, 200, {
        runId: run.id,
        storyId,
        cmd: `claude ${run.args.join(' ')}`,
        prompt: run.prompt, // va por stdin, no en la línea de comandos
        cwd: repoDir,
        sourceRepo: preflight?.repoDir || selectedRepo,
        isolated: workspaceInfo.isolated,
        worktree: workspaceInfo.worktree,
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
        correctionRound: run.correctionRound, maxCorrectionRounds: MAX_CORRECTION_ROUNDS,
        correctionCounts: run.correctionCounts,
        usagePlan: run.accountUsagePlan, tokenUsage: run.tokenUsage,
        cwd: run.cwd, sourceRepo: run.sourceRepo, sourceScope: run.sourceScope,
        scope: path.relative(run.sourceRepo || run.sourceScope, run.sourceScope || run.sourceRepo) || '.',
        baseBranch: run.baseBranch, workspaceInfo: run.workspaceInfo,
        prompt: run.prompt, vivo: !!run.child,
      });
    }

    m = p.match(/^\/api\/run\/([\w-]+)\/report$/);
    if (m && req.method === 'GET') {
      const run = runs.get(m[1]);
      if (!run || !run.storyId) return json(res, 404, { error: 'reporte no encontrado' });
      const report = path.join(runDirFor(run.cwd, run.storyId), 'report.pdf');
      const body = await fsp.readFile(report).catch(() => null);
      if (!body) return json(res, 404, { error: 'reporte no encontrado' });
      const filename = `${run.storyId.replace(/[^\w.-]+/g, '-')}-sdlc-report.pdf`;
      res.writeHead(200, {
        'content-type': 'application/pdf',
        'content-length': body.length,
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
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
        t: 'snapshot', status: run.status, elapsedMs: runElapsed(run),
        connection: run.sessionId && run.child ? 'connected' : (run.child ? 'starting' : 'closed'),
        correctionRound: run.correctionRound, maxCorrectionRounds: MAX_CORRECTION_ROUNDS,
        correctionCounts: run.correctionCounts,
        usagePlan: run.accountUsagePlan, tokenUsage: run.tokenUsage,
        at: Date.now(),
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
  console.log(`\n  sdlc studio`);
  console.log(`  ───────────────────────────────────────────`);
  console.log(`  plugin : ${PLUGIN_DIR}`);
  console.log(`  repo   : ${TARGET_REPO}`);
  console.log(`  url    : http://127.0.0.1:${PORT}\n`);
});
