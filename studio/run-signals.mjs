/** Señales puras del stream que el Studio usa para recuperar y cerrar runs. */

export const MAX_CORRECTION_ROUNDS = 3;

export const EMPTY_TOKEN_USAGE = Object.freeze({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
});

/** Normaliza el uso que Claude adjunta a cada mensaje, sin contar dos veces. */
export function addTokenUsage(total = EMPTY_TOKEN_USAGE, usage = {}) {
  const cacheCreation = usage.cache_creation || {};
  return {
    input: Math.max(0, Number(total.input) || 0) + Math.max(0, Number(usage.input_tokens) || 0),
    output: Math.max(0, Number(total.output) || 0) + Math.max(0, Number(usage.output_tokens) || 0),
    cacheRead: Math.max(0, Number(total.cacheRead) || 0) + Math.max(0, Number(usage.cache_read_input_tokens) || 0),
    cacheWrite: Math.max(0, Number(total.cacheWrite) || 0)
      + Math.max(0, Number(usage.cache_creation_input_tokens) || 0)
      + Math.max(0, Number(cacheCreation.ephemeral_5m_input_tokens) || 0)
      + Math.max(0, Number(cacheCreation.ephemeral_1h_input_tokens) || 0),
  };
}

/** Decide qué significa "consumo" según la credencial que realmente gana. */
export function usagePlan(auth = {}, env = {}) {
  const method = String(auth.authMethod || '').toLowerCase();
  const provider = String(auth.apiProvider || '').toLowerCase();
  if (env.CLAUDE_CODE_USE_BEDROCK || provider.includes('bedrock')) {
    return { kind: 'provider', label: 'Amazon Bedrock' };
  }
  if (env.CLAUDE_CODE_USE_VERTEX || provider.includes('vertex')) {
    return { kind: 'provider', label: 'Google Vertex AI' };
  }
  if (env.CLAUDE_CODE_USE_FOUNDRY || provider.includes('foundry')) {
    return { kind: 'provider', label: 'Microsoft Foundry' };
  }
  if (env.CLAUDE_CODE_USE_ANTHROPIC_AWS || provider.includes('anthropicaws')) {
    return { kind: 'provider', label: 'Claude Platform on AWS' };
  }
  if (env.ANTHROPIC_AUTH_TOKEN) return { kind: 'provider', label: 'Gateway externo' };
  if (env.ANTHROPIC_API_KEY || /api.?key|console/.test(method)) {
    return { kind: 'api', label: 'API por uso' };
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN || /oauth|claude.?ai|subscription|sso/.test(method)) {
    return { kind: 'subscription', label: 'Crédito mensual SDK' };
  }
  return { kind: 'unknown', label: auth.loggedIn ? 'Cuenta no identificada' : 'Sin sesión' };
}

/**
 * Una ronda correctiva empieza cuando el desarrollador vuelve a intervenir
 * después de QA/seguridad o reviewer. La implementación inicial no cuenta.
 */
export function correctionRoundForTransition(phase, round, agent) {
  const current = Math.max(0, Number(round) || 0);
  return agent === 'desarrollador' && Number(phase) >= 5 ? current + 1 : current;
}

/** Atribuye la ronda al auditor que devolvió el trabajo a implementación. */
export function correctionSourceForTransition(phase, agent, requestedSource) {
  if (agent !== 'desarrollador' || Number(phase) < 5) return null;
  if (['verification', 'reviewer'].includes(requestedSource)) return requestedSource;
  return Number(phase) >= 6 ? 'reviewer' : 'verification';
}

/** Traduce el veredicto de un auditor al retorno visual del mapa. */
export function auditCorrection(agent, verdict) {
  const name = String(agent || '').toLowerCase();
  const result = String(verdict || '').toUpperCase();
  if (name === 'reviewer' && ['APPROVE', 'REQUEST_CHANGES'].includes(result)) {
    return {
      source: 'reviewer', phase: 6, requested: result === 'REQUEST_CHANGES', verdict: result,
    };
  }
  if (['qa', 'seguridad'].includes(name) && result === 'FAIL') {
    return { source: 'verification', phase: 5, requested: true, verdict: result };
  }
  return null;
}

export const RECOVERY_PROMPT = `El cierre anterior quedó técnicamente incompleto; no es una decisión del usuario. Antes de repetir nada, reconciliá los efectos persistidos: inspeccioná archivos y artefactos del run, git status, git diff y commits recientes, el estado del subagente y el PR remoto si correspondía. No afirmes que faltan commits o archivos sin verificar esas fuentes. Si la operación ya produjo su efecto, no la repitas. Si faltó el JSON final de un subagente, reinvocalo solo para inspeccionar lo existente, completar lo estrictamente pendiente y devolver su contrato; no rehagas la implementación. Continuá desde la fase siguiente cuando la evidencia lo permita. No pidas confirmación humana para recuperarte.`;

export function technicalToolInterruption(text) {
  const clean = String(text || '').trim();
  if (/^\[?request interrupted by user(?: for tool use)?\]?$/i.test(clean)) return true;
  const incompleteAgent = /\b(?:subagente|desarrollador|agente)\b[\s\S]{0,1400}(?:\bno\b[^.\n]{0,220}\b(?:devolvi[oó]|devuelto|emiti[oó]|emitido|entreg[oó]|entregado|produjo|producido)\b[^.\n]{0,160}\b(?:veredicto|json|salida formal)\b|\bsin (?:el )?(?:veredicto|json|salida formal)\b|\bse (?:cort[oó]|interrumpi[oó])\b|\btermin[oó] antes de\b[^.\n]{0,120}\b(?:veredicto|json)\b)/i;
  return incompleteAgent.test(clean);
}

/** Solo abre una acción humana cuando el texto se dirige realmente al usuario. */
export function humanInputRequest(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  const lines = clean.split(/\n+/)
    .map(line => line.replace(/^\s*[-*#>]+\s*/, '').trim())
    .filter(Boolean);
  const questions = lines.filter(line => /[?？]/.test(line)).slice(-3);
  const approval = /(?:necesito|necesita|necesitamos|requiere|falta|esperando)\s+(?:de\s+)?(?:tu|su)\s+(?:aprobaci[oó]n|confirmaci[oó]n)|[¿?]\s*(?:aprob[aá]s|confirm[aá]s)|\b(?:aprob[aá]|confirm[aá])\s+(?:para|que|si)\b/i.test(clean);
  const explicitRequest = /(?:para continuar\s+(?:necesito|respond[eé]|indic[aá])|necesito que (?:respondas|elijas|decidas)|\b(?:respond[eé]|eleg[ií]|decid[ií]|indic[aá])\s+(?:esto|una opci[oó]n|c[oó]mo))/i.test(clean);

  if (!questions.length && !approval && !explicitRequest) return null;
  return {
    reason: approval
      ? 'Claude necesita tu aprobación para continuar'
      : 'Claude necesita una respuesta tuya para continuar',
    questions: questions.length ? questions : [clean.slice(-600)],
  };
}

/** Comandos que crean o inspeccionan el PR final en los trackers soportados. */
export function prCommand(command) {
  const cmd = String(command || '');
  const creates = /\b(?:gh pr create|az repos pr create|glab mr create)\b/.test(cmd);
  const touches = creates || /\b(?:gh pr (?:view|edit)|az repos pr (?:show|update)|glab mr (?:view|update))\b/.test(cmd);
  return { creates, touches };
}

/** Herramientas MCP cuyo nombre evidencia creación, lectura o actualización de PR. */
export function prTool(name) {
  const tool = String(name || '').toLowerCase();
  const creates = /(?:^|__|_)(?:create_pull_request|repo_create_pull_request|pull_request_create)$/.test(tool);
  const touches = creates || /(?:^|__|_)(?:get_pull_request|pull_request_read|repo_get_pull_request_by_id|update_pull_request|repo_update_pull_request)$/.test(tool);
  return { creates, touches };
}

/**
 * Un resumen solo cierra el ciclo si una herramienta confirmó antes el PR.
 * La prosa sirve como segunda señal, no como sustituto de evidencia externa.
 */
export function finalCycleCompletion(text, prConfirmed = false) {
  if (!prConfirmed) return false;
  const clean = String(text || '');
  const saysComplete = /\bciclo\s+completo\b|\blist[oa]\s+para\s+revisi[oó]n\s+humana\b/i.test(clean);
  const deniesCompletion = /\b(?:no|todav[ií]a\s+no|a[uú]n\s+no)\s+(?:est[aá]\s+)?list[oa]\s+para\s+revisi[oó]n\s+humana\b|\bciclo\s+(?:no\s+)?incompleto\b/i.test(clean);
  const hasPr = /\bPR\s*:\s*https?:\/\/\S+|https?:\/\/\S+\/(?:pull|pullrequest|merge_requests)\/\d+/i.test(clean);
  return saysComplete && !deniesCompletion && hasPr;
}
