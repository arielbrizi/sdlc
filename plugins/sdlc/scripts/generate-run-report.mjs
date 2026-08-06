#!/usr/bin/env node
// Genera un reporte PDF autocontenido desde los artefactos de un run SDLC.
// No usa dependencias externas: el plugin tiene que funcionar recién instalado.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

const AGENTS = [
  ['refinamiento', 'Refinamiento'],
  ['arquitectura', 'Arquitectura'],
  ['ux', 'Diseño de interfaz'],
  ['desarrollador', 'Implementación'],
  ['qa', 'QA'],
  ['seguridad', 'Seguridad'],
  ['reviewer', 'Revisión final'],
];

const ARTIFACT = {
  refinamiento: 'refinement.json', arquitectura: 'architecture.json',
  ux: 'design.json', desarrollador: 'implementation.json', qa: 'qa.json',
  seguridad: 'security.json', reviewer: 'review.json',
};

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function flat(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(flat).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `${key}: ${flat(item)}`).join(' | ');
  }
  return String(value);
}

function firstLines(text, limit = 5) {
  return String(text || '').split('\n').map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line))
    .map(line => line.replace(/^[-*]\s+/, '').replace(/[*_`#]/g, '').trim())
    .filter(Boolean).slice(0, limit);
}

function section(text, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text || '').match(new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'mi'))?.[1]?.trim() || '';
}

function agentConfig(name) {
  const text = readText(path.join(PLUGIN_ROOT, 'agents', `${name}.md`));
  const get = key => text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() || '';
  return { model: get('model'), effort: get('effort'), maxTurns: get('maxTurns') };
}

function agentActivity(name, timeline) {
  const events = String(timeline || '').split('\n').filter(line =>
    line.includes(`agent=sdlc:${name} `) && line.includes(' finished'));
  return {
    executions: events.length,
    finishedAt: events.at(-1)?.match(/^(\S+)/)?.[1] || '',
  };
}

function listDecisions(agent, data, plan, design) {
  if (!data) return [];
  if (agent === 'refinamiento') return [
    ...array(data.assumptions_safe_to_make).map(x => `Supuesto seguro: ${flat(x)}`),
    ...array(data.blocking_questions).map(x => `Decisión pendiente: ${flat(x)}`),
  ];
  if (agent === 'arquitectura') {
    const d = data.decision_summary || {};
    const structured = [
      ...array(d.guidelines).map(x => `Lineamiento: ${flat(x)}`),
      ...array(d.technologies).map(x => `Tecnología: ${flat(x)}`),
      ...array(d.patterns).map(x => `Patrón: ${flat(x)}`),
      ...array(d.constraints).map(x => `Restricción: ${flat(x)}`),
    ];
    return structured.length ? structured : firstLines(section(plan, 'Estado actual'), 4);
  }
  if (agent === 'ux') {
    const d = data.decision_summary || {};
    const structured = [
      ...array(d.reuse).map(x => `Reuso: ${flat(x)}`),
      ...array(d.new_components).map(x => `Nuevo: ${flat(x)}`),
      ...array(d.tokens).map(x => `Token: ${flat(x)}`),
      ...array(d.interactions).map(x => `Interacción: ${flat(x)}`),
      ...array(d.accessibility).map(x => `Accesibilidad: ${flat(x)}`),
    ];
    return structured.length ? structured : firstLines(section(design, 'Supuestos y desviaciones respecto de Figma'), 5);
  }
  if (agent === 'desarrollador') return [
    ...array(data.files_changed).map(x => `${x.action || 'modified'}: ${x.path || flat(x)}`),
    ...array(data.commits).map(x => `Commit: ${flat(x)}`),
    ...(data.notes ? [`Nota: ${flat(data.notes)}`] : []),
  ];
  if (agent === 'qa') return [
    ...array(data.findings).map(x => `${x.severity || 'finding'}: ${x.issue || flat(x)}`),
    ...(data.regression_risk ? [`Riesgo de regresión: ${flat(data.regression_risk)}`] : []),
  ];
  if (agent === 'seguridad') return [
    ...array(data.findings).map(x => `${x.severity || 'finding'} - ${x.category || 'seguridad'}: ${x.description || flat(x)}`),
    ...array(data.dependencies_added).map(x => `Dependencia: ${flat(x)}`),
  ];
  if (agent === 'reviewer') return [
    ...array(data.blocking).map(x => `Bloqueante: ${x.issue || flat(x)}`),
    ...array(data.non_blocking).map(x => `Opcional: ${x.suggestion || flat(x)}`),
    ...array(data.review_focus_for_human).map(x => `Foco humano: ${flat(x)}`),
  ];
  return [];
}

function evidence(agent, data) {
  if (!data) return [];
  if (agent === 'refinamiento') return [`${array(data.acceptance_criteria_normalized).length} criterios normalizados`, `Blast radius estimado: ${data.estimated_blast_radius || 'no informado'}`];
  if (agent === 'arquitectura') return [`Blast radius: ${data.blast_radius || 'no informado'}`];
  if (agent === 'ux') return Object.entries(data.sources || {}).map(([key, value]) => `${key}: ${flat(value)}`);
  if (agent === 'desarrollador') return [
    `${array(data.files_changed).length} archivos informados`,
    `Tests: ${flat(data.tests?.run || 'no informados')}`,
    `${array(data.acceptance_criteria).length} criterios con cobertura informada`,
  ];
  if (agent === 'qa') return [`Cobertura: ${array(data.acceptance_coverage).length} criterios`, `Tests: ${flat(data.test_run || 'no informados')}`];
  if (agent === 'seguridad') return [`${array(data.findings).length} hallazgos`, `${array(data.dependencies_added).length} dependencias evaluadas`];
  if (agent === 'reviewer') return [`${array(data.blocking).length} bloqueantes`, `${array(data.non_blocking).length} observaciones opcionales`];
  return [];
}

function retrospective(agent, data, file, plan, design, activity) {
  if (!data) return ['No hay artefacto: el agente fue omitido, no llegó a ejecutarse o el run quedó incompleto.'];
  const notes = [];
  if (activity.executions > 1) notes.push(`${activity.executions} ejecuciones registradas: revisar la causa del reintento o retrabajo.`);
  const bytes = fs.statSync(file).size;
  if (bytes > 20_000) notes.push(`Salida estructurada extensa: ${Math.ceil(bytes / 1024)} KB; revisar duplicación o verbosidad.`);
  if (array(data.blocking_questions).length) notes.push(`${data.blocking_questions.length} decisiones requirieron intervención humana.`);
  if (agent === 'arquitectura') {
    const lines = plan ? plan.split('\n').length : 0;
    const budget = data.blast_radius === 'medium' ? 240 : 120;
    notes.push(`plan.md: ${lines} líneas (presupuesto ${budget}).`);
    if (!data.decision_summary) notes.push('Run anterior al ledger estructurado: tecnologías y patrones pueden quedar sólo en plan.md.');
  }
  if (agent === 'ux') {
    const lines = design ? design.split('\n').length : 0;
    notes.push(`design.md: ${lines} líneas (presupuesto 120 low / 240 medium).`);
    if (!data.decision_summary) notes.push('Run anterior al ledger estructurado: decisiones visuales no están resumidas en JSON.');
  }
  if (agent === 'qa' && data.verdict === 'FAIL') notes.push('QA pidió correcciones: revisar si los criterios o el plan pudieron prevenirlas antes.');
  if (agent === 'seguridad' && data.verdict === 'FAIL') notes.push('Seguridad pidió correcciones: revisar si arquitectura debía explicitar el control antes.');
  if (agent === 'reviewer' && data.verdict === 'REQUEST_CHANGES') notes.push('Reviewer devolvió el cambio: clasificar si el hallazgo pertenecía a implementación, QA o arquitectura.');
  if (!notes.length) notes.push('Sin señales automáticas de sobretrabajo o cierre incompleto.');
  return notes;
}

export function buildReportModel(runDir, options = {}) {
  const story = readJson(path.join(runDir, 'story.json'), {});
  const git = readJson(path.join(runDir, 'git.json'), {});
  const run = readJson(path.join(runDir, 'run.json'), {});
  const plan = readText(path.join(runDir, 'plan.md'));
  const design = readText(path.join(runDir, 'design.md'));
  const timeline = readText(path.join(runDir, 'timeline.log'));
  const agents = AGENTS.map(([name, label]) => {
    const file = path.join(runDir, ARTIFACT[name]);
    const data = readJson(file);
    const activity = agentActivity(name, timeline);
    return {
      name, label, config: agentConfig(name), available: !!data,
      verdict: data?.verdict || 'NO_EJECUTADO',
      decisions: listDecisions(name, data, plan, design).slice(0, 20),
      evidence: [
        ...(activity.executions ? [`Ejecuciones registradas: ${activity.executions}`] : []),
        ...(activity.finishedAt ? [`Último cierre: ${activity.finishedAt}`] : []),
        ...evidence(name, data),
      ],
      retrospective: retrospective(name, data, file, plan, design, activity),
    };
  });
  return {
    title: `${story.id || path.basename(runDir)} - ${story.title || 'Reporte del ciclo'}`,
    generatedAt: new Date().toISOString(),
    story: {
      id: story.id || path.basename(runDir), title: story.title || 'Sin título',
      tracker: story.tracker || 'desconocido', url: story.url || '',
      criteria: array(story.acceptance_criteria).length,
    },
    run: {
      branch: git.branch || run.branch || 'no informada',
      base: git.base_ref || git.base_branch || 'no informada',
      startedAt: run.started_at || '',
      prUrl: options.prUrl || '',
    },
    agents,
  };
}

function pdfText(value) {
  return String(value || '')
    .replace(/[–—‑]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/→/g, '->').replace(/✓/g, 'OK').replace(/•/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?');
}

function escapePdf(value) {
  return pdfText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(value, width, size) {
  const max = Math.max(18, Math.floor(width / (size * 0.52)));
  const words = pdfText(value).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (word.length > max) {
      if (line) lines.push(line);
      for (let i = 0; i < word.length; i += max) lines.push(word.slice(i, i + max));
      line = '';
    } else if (!line || line.length + word.length + 1 <= max) {
      line = line ? `${line} ${word}` : word;
    } else {
      lines.push(line); line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

class PdfReport {
  constructor(title) {
    this.title = title; this.pages = []; this.commands = []; this.pageNo = 0;
    this.width = 595.28; this.height = 841.89; this.margin = 46; this.y = 0;
    this.newPage();
  }
  newPage() {
    if (this.commands.length) this.pages.push(this.commands.join('\n'));
    this.commands = []; this.pageNo += 1; this.y = this.height - 58;
    this.rect(0, this.height - 30, this.width, 30, [0.11, 0.20, 0.33]);
    this.text('SDLC - REPORTE DE EJECUCION', this.margin, this.height - 20, 8, true, [1, 1, 1]);
    this.line(this.margin, 38, this.width - this.margin, 38, [0.82, 0.85, 0.89]);
    this.text(pdfText(this.title).slice(0, 72), this.margin, 25, 7, false, [0.35, 0.39, 0.45]);
    this.text(`Página ${this.pageNo}`, this.width - this.margin - 42, 25, 7, false, [0.35, 0.39, 0.45]);
  }
  finishPage() { if (this.commands.length) this.pages.push(this.commands.join('\n')); }
  ensure(height) { if (this.y - height < 54) this.newPage(); }
  text(value, x, y, size = 9, bold = false, color = [0.12, 0.15, 0.20]) {
    this.commands.push(`${color.join(' ')} rg BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdf(value)}) Tj ET`);
  }
  rect(x, y, w, h, color) { this.commands.push(`${color.join(' ')} rg ${x} ${y} ${w} ${h} re f`); }
  line(x1, y1, x2, y2, color) { this.commands.push(`${color.join(' ')} RG 0.6 w ${x1} ${y1} m ${x2} ${y2} l S`); }
  heading(value, level = 1) {
    const size = level === 1 ? 18 : level === 2 ? 13 : 10;
    const gap = level === 1 ? 30 : 22;
    this.ensure(gap + 10); this.y -= level === 1 ? 4 : 2;
    if (level === 2) this.rect(this.margin, this.y - 4, 4, 15, [0.18, 0.43, 0.78]);
    this.text(value, this.margin + (level === 2 ? 11 : 0), this.y, size, true, level === 1 ? [0.08, 0.18, 0.32] : [0.12, 0.23, 0.38]);
    this.y -= gap;
  }
  paragraph(value, options = {}) {
    const size = options.size || 9; const indent = options.indent || 0;
    const leading = size + 3; const lines = wrap(value, this.width - this.margin * 2 - indent, size);
    this.ensure(lines.length * leading + 6);
    for (const line of lines) { this.text(line, this.margin + indent, this.y, size, !!options.bold, options.color); this.y -= leading; }
    this.y -= options.after ?? 4;
  }
  bullet(value, color) {
    const size = 8.6; const leading = 11.4; const lines = wrap(value, this.width - this.margin * 2 - 18, size);
    this.ensure(lines.length * leading + 4);
    this.text('-', this.margin + 3, this.y, size, true, color);
    for (const line of lines) { this.text(line, this.margin + 16, this.y, size, false, color); this.y -= leading; }
    this.y -= 2;
  }
  labelValue(label, value) {
    this.ensure(18); this.text(label.toUpperCase(), this.margin, this.y, 7.5, true, [0.38, 0.43, 0.50]);
    this.text(value, this.margin + 112, this.y, 8.5, false, [0.12, 0.15, 0.20]); this.y -= 16;
  }
}

function renderModel(model) {
  const pdf = new PdfReport(model.title);
  pdf.heading('Reporte final del ciclo SDLC', 1);
  pdf.paragraph(model.title, { size: 12, bold: true, after: 12 });
  pdf.labelValue('Historia', model.story.id);
  pdf.labelValue('Tracker', model.story.tracker);
  pdf.labelValue('Criterios', String(model.story.criteria));
  pdf.labelValue('Branch', model.run.branch);
  pdf.labelValue('Base', model.run.base);
  if (model.run.startedAt) pdf.labelValue('Inicio', model.run.startedAt);
  if (model.run.prUrl) pdf.labelValue('Pull Request', model.run.prUrl);
  pdf.labelValue('Generado', model.generatedAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'));
  pdf.y -= 8;
  pdf.heading('Resumen ejecutivo', 2);
  const executed = model.agents.filter(a => a.available).length;
  pdf.paragraph(`${executed} de ${model.agents.length} agentes dejaron artefacto. Este reporte registra decisiones y evidencia ya producidas por el ciclo; no agrega una evaluación de otro modelo.`);
  for (const agent of model.agents) {
    const color = agent.available ? [0.10, 0.38, 0.23] : [0.55, 0.31, 0.08];
    pdf.bullet(`${agent.label}: ${agent.verdict}`, color);
  }
  for (const agent of model.agents) {
    // Evita dejar el nombre del agente aislado al pie de una página.
    pdf.ensure(130);
    pdf.heading(agent.label, 1);
    pdf.labelValue('Veredicto', agent.verdict);
    pdf.labelValue('Configuración', `${agent.config.model || '?'} / effort ${agent.config.effort || '?'} / max ${agent.config.maxTurns || '?'} turnos`);
    pdf.heading('Decisiones y lineamientos', 2);
    if (agent.decisions.length) agent.decisions.forEach(item => pdf.bullet(item));
    else pdf.paragraph('No se registraron decisiones estructuradas para este agente.', { color: [0.42, 0.45, 0.50] });
    pdf.heading('Evidencia y resultado', 2);
    if (agent.evidence.length) agent.evidence.forEach(item => pdf.bullet(item));
    else pdf.paragraph('Sin evidencia estructurada disponible.', { color: [0.42, 0.45, 0.50] });
    pdf.heading('Señales para retrospectiva', 2);
    agent.retrospective.forEach(item => pdf.bullet(item, [0.40, 0.24, 0.05]));
  }
  pdf.finishPage();
  return pdf;
}

function encodeObject(id, body) {
  return Buffer.from(`${id} 0 obj\n${body}\nendobj\n`, 'latin1');
}

export function writePdf(model, outputFile) {
  const report = renderModel(model);
  const objects = new Map();
  const pageIds = [];
  let next = 5;
  for (const stream of report.pages) {
    const pageId = next++; const contentId = next++; pageIds.push(pageId);
    const bytes = Buffer.from(stream, 'latin1');
    objects.set(contentId, `<< /Length ${bytes.length} >>\nstream\n${stream}\nendstream`);
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
  }
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objects.set(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1');
  const chunks = [header]; const offsets = [0]; let offset = header.length;
  for (let id = 1; id < next; id++) {
    offsets[id] = offset;
    const chunk = encodeObject(id, objects.get(id)); chunks.push(chunk); offset += chunk.length;
  }
  const xrefAt = offset;
  let xref = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id++) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, Buffer.concat(chunks));
  return { outputFile, pages: report.pages.length };
}

function parseArgs(argv) {
  const out = { id: '', runDir: '', output: '', prUrl: '' };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--run-dir') out.runDir = argv[++i] || '';
    else if (value === '--output') out.output = argv[++i] || '';
    else if (value === '--pr-url') out.prUrl = argv[++i] || '';
    else if (!out.id) out.id = value;
    else throw new Error(`argumento desconocido: ${value}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const runDir = args.runDir || (args.id ? path.join(project, '.claude', 'run', args.id.replace(/^#/, '')) : '');
  if (!runDir || !fs.statSync(runDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('uso: generate-run-report.mjs <ID> [--run-dir DIR] [--output PDF] [--pr-url URL]');
  }
  const output = args.output || path.join(runDir, 'report.pdf');
  const result = writePdf(buildReportModel(runDir, { prUrl: args.prUrl }), output);
  process.stdout.write(`${JSON.stringify({ ok: true, file: result.outputFile, pages: result.pages })}\n`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`error: ${error.message}`); process.exit(2); }
}
